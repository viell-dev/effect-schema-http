import { Cause, Context, Deferred, Effect, Either, Exit, Fiber, Option, Scope } from "effect";
import { describe, expect, it } from "vitest";
import * as Interaction from "./Interaction.js";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

describe("scoped interactions", () => {
  it("is lazy, retains one success and supports forced refresh", async () => {
    let calls = 0;
    await run(
      Effect.gen(function* () {
        const interaction = yield* Interaction.make((input: string) => Effect.sync(() => `${input}:${++calls}`));
        const lazy = interaction.run("a");
        expect(calls).toBe(0);
        expect(yield* lazy).toBe("a:1");
        expect(yield* interaction.run("a")).toBe("a:1");
        expect(yield* interaction.run("a", { force: true })).toBe("a:2");
        expect(yield* interaction.run("b")).toBe("b:3");
        expect(yield* interaction.run("a")).toBe("a:4");
      }),
    );
  });

  it("shares equal work, and canceling a waiter leaves the owner alive", async () => {
    let calls = 0;
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<number>();
        const interaction = yield* Interaction.make<string, number, never, never>(() =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(release);
          }),
        );
        const first = yield* Effect.fork(interaction.run("a"));
        yield* Deferred.await(started);
        const second = yield* Effect.fork(interaction.run("a"));
        yield* Effect.yieldNow();
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(release, 42);
        expect(yield* Fiber.join(second)).toBe(42);
        expect(calls).toBe(1);
      }),
    );
  });

  it("supersedes changed input even when returning a retained value", async () => {
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const interaction = yield* Interaction.make((input: string) =>
          input === "a"
            ? Effect.succeed("A")
            : Effect.zipRight(Deferred.succeed(started, undefined), Effect.never).pipe(
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
        );
        expect(yield* interaction.run("a")).toBe("A");
        const pending = yield* Effect.fork(interaction.run("b"));
        yield* Deferred.await(started);
        expect(yield* interaction.run("a")).toBe("A");
        yield* Deferred.await(stopped);
        const exit = yield* Fiber.await(pending);
        expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
      }),
    );
  });

  it("force supersedes equivalent work and releases joined callers", async () => {
    let calls = 0;
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interaction = yield* Interaction.make<string, string, never, never>(() =>
          Effect.suspend(() =>
            ++calls === 1
              ? Effect.zipRight(Deferred.succeed(started, undefined), Effect.never)
              : Effect.succeed("fresh"),
          ),
        );
        const first = yield* Effect.fork(interaction.run("a"));
        yield* Deferred.await(started);
        const joined = yield* Effect.fork(interaction.run("a"));
        yield* Effect.yieldNow();
        expect(yield* interaction.run("a", { force: true })).toBe("fresh");
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(joined))).toBe(true);
        expect(calls).toBe(2);
      }),
    );
  });

  it("retention exclusion clears an equivalent key and preserves an unrelated key", async () => {
    let retain = true;
    let calls = 0;
    let classifications = 0;
    await run(
      Effect.gen(function* () {
        const interaction = yield* Interaction.make((input: string) => Effect.sync(() => `${input}:${++calls}`), {
          retain: () => {
            classifications++;
            return retain;
          },
        });
        expect(yield* interaction.run("a")).toBe("a:1");
        retain = false;
        expect(yield* interaction.run("b")).toBe("b:2");
        expect(yield* interaction.run("a")).toBe("a:1");
        expect(classifications).toBe(2);
        expect(yield* interaction.run("a", { force: true })).toBe("a:3");
        expect(yield* interaction.run("a")).toBe("a:4");
      }),
    );
  });

  it("retains successes across failures and recovers from synchronous defects", async () => {
    let fail = false;
    let defect = false;
    await run(
      Effect.gen(function* () {
        const interaction = yield* Interaction.make((input: string) => {
          if (defect) throw new Error("construction failed");
          return fail ? Effect.fail("failed") : Effect.succeed(input);
        });
        expect(yield* interaction.run("a")).toBe("a");
        fail = true;
        expect(Either.isLeft(yield* Effect.either(interaction.run("a", { force: true })))).toBe(true);
        expect(yield* interaction.run("a")).toBe("a");
        defect = true;
        expect(Exit.isFailure(yield* Effect.exit(interaction.run("b")))).toBe(true);
        defect = false;
        fail = false;
        expect(yield* interaction.run("b")).toBe("b");
      }),
    );
  });

  it("predicate defects release every waiter and future admission", async () => {
    let throws = true;
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interaction = yield* Interaction.make(
          (input: string) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return input;
            }),
          {
            retain: () => {
              if (throws) throw new Error("predicate");
              return true;
            },
          },
        );
        const a = yield* Effect.fork(interaction.run("a"));
        yield* Deferred.await(started);
        const b = yield* Effect.fork(interaction.run("a"));
        yield* Effect.yieldNow();
        yield* Deferred.succeed(release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(a))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(b))).toBe(true);
        throws = false;
        expect(yield* interaction.run("a")).toBe("a");
      }),
    );
  });

  it("close awaits superseded finalizers, is concurrent-idempotent, and prevents reuse", async () => {
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finalizing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interaction = yield* Interaction.make((input: string) =>
          input === "a"
            ? Effect.zipRight(Deferred.succeed(started, undefined), Effect.never).pipe(
                Effect.ensuring(Effect.zipRight(Deferred.succeed(finalizing, undefined), Deferred.await(release))),
              )
            : Effect.succeed("b"),
        );
        const old = yield* Effect.fork(interaction.run("a"));
        yield* Deferred.await(started);
        expect(yield* interaction.run("b")).toBe("b");
        yield* Deferred.await(finalizing);
        const close1 = yield* Effect.fork(interaction.close);
        const close2 = yield* Effect.fork(interaction.close);
        yield* Effect.yieldNow();
        expect(Option.isNone(yield* Fiber.poll(close1))).toBe(true);
        expect(Option.isNone(yield* Fiber.poll(close2))).toBe(true);
        const rejected = yield* Effect.either(interaction.run("b"));
        expect(Either.isLeft(rejected) && rejected.left._tag).toBe("InteractionClosed");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(close1);
        yield* Fiber.join(close2);
        yield* Fiber.await(old);
      }),
    );
  });

  it("captures services and closes with its acquisition scope", async () => {
    class Prefix extends Context.Tag("interaction/Prefix")<Prefix, string>() {}
    const interaction = await Effect.runPromise(
      Effect.scoped(Interaction.make((input: string) => Effect.map(Prefix, (value) => value + input))).pipe(
        Effect.provideService(Prefix, "prefix:"),
      ),
    );
    const rejected = await Effect.runPromise(Effect.either(interaction.run("a")));
    expect(Either.isLeft(rejected) && rejected.left._tag).toBe("InteractionClosed");
  });
  it("gives each worker its own scope for acquired resources", async () => {
    const finalized: Array<string> = [];
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interaction = yield* Interaction.make((input: string) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(Effect.succeed(input), (value) =>
              Effect.sync(() => {
                finalized.push(value);
              }),
            );
            if (input === "a") {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            return input;
          }),
        );
        const first = yield* Effect.fork(interaction.run("a"));
        yield* Deferred.await(started);
        expect(yield* interaction.run("b")).toBe("b");
        yield* Fiber.await(first);
        expect(new Set(finalized)).toEqual(new Set(["a", "b"]));
        expect(yield* interaction.run("b")).toBe("b");
        expect(finalized).toHaveLength(2);
      }),
    );
  });
});
