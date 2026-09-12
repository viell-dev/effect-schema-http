import { Cause, Deferred, Effect, Either, Exit, Fiber } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { makeRequestGate } from "./makeRequestGate.js";

const interrupted = <A, E>(exit: Exit.Exit<A, E>) => Exit.isFailure(exit) && Cause.isInterrupted(exit.cause);

describe("interaction gate", () => {
  it("is lazy, retains one success, and explicitly forces re-execution", async () => {
    let calls = 0;
    const gate = await Effect.runPromise(
      makeRequestGate((input: string) => Effect.sync(() => `${input}:${++calls}`), { key: String }),
    );
    const pending = gate.run("a");
    expect(calls).toBe(0);
    expect(await Effect.runPromise(pending)).toBe("a:1");
    expect(await Effect.runPromise(gate.run("a"))).toBe("a:1");
    expect(await Effect.runPromise(gate.run("a", { force: true }))).toBe("a:2");
    expect(await Effect.runPromise(gate.run("b"))).toBe("b:3");
    expect(await Effect.runPromise(gate.run("a"))).toBe("a:4");
    await Effect.runPromise(gate.dispose);
  });

  it("automatically interrupts changed input before returning a cached result", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let calls = 0;
        const gate = yield* makeRequestGate(
          (input: string) =>
            input === "a"
              ? Effect.sync(() => `${input}:${++calls}`)
              : Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
          { key: String },
        );
        expect(yield* gate.run("a")).toBe("a:1");
        const b = yield* Effect.fork(gate.run("b"));
        yield* Deferred.await(started);
        expect(yield* gate.run("a")).toBe("a:1");
        expect(interrupted(yield* Fiber.await(b))).toBe(true);
        yield* gate.dispose;
      }),
    );
  });

  it("joins equal work and interrupting a waiter leaves the owner alive", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const gate = yield* makeRequestGate(
          (input: string) =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return input;
            }),
          { key: String },
        );
        const owner = yield* Effect.fork(gate.run("a"));
        yield* Deferred.await(started);
        const waiter = yield* Effect.fork(gate.run("a"));
        yield* Effect.yieldNow();
        expect(interrupted(yield* Fiber.interrupt(waiter))).toBe(true);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(owner)).toBe("a");
        expect(calls).toBe(1);
        yield* gate.dispose;
      }),
    );
  });

  it("force interrupts equivalent work rather than joining it", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let calls = 0;
        const gate = yield* makeRequestGate(
          (_input: string) =>
            ++calls === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never))
              : Effect.succeed(calls),
          { key: String },
        );
        const first = yield* Effect.fork(gate.run("a"));
        yield* Deferred.await(started);
        expect(yield* gate.run("a", { force: true })).toBe(2);
        expect(interrupted(yield* Fiber.await(first))).toBe(true);
        yield* gate.dispose;
      }),
    );
  });

  it("retains the last success through failures and never retains a superseded completion", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const gate = yield* makeRequestGate(
          (input: string) =>
            input === "slow"
              ? Effect.uninterruptible(
                  Deferred.succeed(started, undefined).pipe(
                    Effect.zipRight(Deferred.await(release)),
                    Effect.as("stale"),
                  ),
                )
              : input === "bad"
                ? Effect.fail("bad")
                : Effect.sync(() => `${input}:${++calls}`),
          { key: String },
        );
        expect(yield* gate.run("good")).toBe("good:1");
        const slow = yield* Effect.fork(gate.run("slow"));
        yield* Deferred.await(started);
        expect(Either.isLeft(yield* Effect.either(gate.run("bad")))).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(slow);
        expect(yield* gate.run("good")).toBe("good:1");
        yield* gate.dispose;
      }),
    );
  });

  it("dispose waits for superseded finalizers and rejects subsequent execution", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finalizing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gate = yield* makeRequestGate(
          (input: string) =>
            input === "slow"
              ? Effect.acquireUseRelease(
                  Deferred.succeed(started, undefined),
                  () => Effect.never,
                  () => Deferred.succeed(finalizing, undefined).pipe(Effect.zipRight(Deferred.await(release))),
                )
              : Effect.void,
          { key: String },
        );
        const old = yield* Effect.fork(gate.run("slow"));
        yield* Deferred.await(started);
        yield* gate.run("new");
        yield* Deferred.await(finalizing);
        let disposed = false;
        const closing = yield* Effect.fork(
          gate.dispose.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                disposed = true;
              }),
            ),
          ),
        );
        yield* Effect.yieldNow();
        expect(disposed).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(closing);
        yield* Fiber.await(old);
        expect(disposed).toBe(true);
        const closed = yield* Effect.either(gate.run("new"));
        expect(Either.isLeft(closed) && closed.left._tag).toBe("GateClosed");
        yield* gate.dispose;
      }),
    );
  });

  it("cleans up synchronous defects so the same input can be retried", async () => {
    let calls = 0;
    const gate = await Effect.runPromise(
      makeRequestGate(
        (input: string) => {
          if (++calls === 1) throw new Error("defect");
          return Effect.succeed(input);
        },
        { key: String },
      ),
    );
    expect(Exit.isFailure(await Effect.runPromiseExit(gate.run("a")))).toBe(true);
    expect(await Effect.runPromise(gate.run("a"))).toBe("a");
    await Effect.runPromise(gate.dispose);
  });
});

type LookupResult = { readonly _tag: "found"; readonly name: string } | { readonly _tag: "forbidden" };

describe("gate retention policy", () => {
  it("shares excluded results unchanged, then executes again without rerunning policy on cache hits", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const forbidden: LookupResult = { _tag: "forbidden" };
        const found: LookupResult = { _tag: "found", name: "Ada" };
        let calls = 0;
        let decisions = 0;
        const gate = yield* makeRequestGate(
          (_input: string) =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return calls === 1 ? forbidden : found;
            }),
          {
            key: String,
            shouldCache: (value, input) => {
              expectTypeOf(value).toEqualTypeOf<LookupResult>();
              expectTypeOf(input).toEqualTypeOf<string>();
              expect(input).toBe("a");
              decisions++;
              return value._tag === "found";
            },
          },
        );
        expect(decisions).toBe(0);
        const owner = yield* Effect.fork(gate.run("a"));
        yield* Deferred.await(started);
        const waiter = yield* Effect.fork(gate.run("a"));
        yield* Effect.yieldNow();
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(owner)).toBe(forbidden);
        expect(yield* Fiber.join(waiter)).toBe(forbidden);
        expect(calls).toBe(1);
        expect(decisions).toBe(1);
        expect(yield* gate.run("a")).toBe(found);
        expect(yield* gate.run("a")).toBe(found);
        expect(calls).toBe(2);
        expect(decisions).toBe(2);
        yield* gate.dispose;
      }),
    );
  });

  it("clears an equivalent retained key on exclusion but preserves an unrelated key", async () => {
    let calls = 0;
    let retain = true;
    const gate = await Effect.runPromise(
      makeRequestGate((input: string) => Effect.sync(() => `${input}:${++calls}`), {
        key: (input) => ({ normalized: input.toLowerCase() }),
        equivalent: (left, right) => left.normalized === right.normalized,
        shouldCache: () => retain,
      }),
    );
    expect(await Effect.runPromise(gate.run("a"))).toBe("a:1");
    retain = false;
    expect(await Effect.runPromise(gate.run("A", { force: true }))).toBe("A:2");
    retain = true;
    expect(await Effect.runPromise(gate.run("a"))).toBe("a:3");
    retain = false;
    expect(await Effect.runPromise(gate.run("b"))).toBe("b:4");
    expect(await Effect.runPromise(gate.run("a"))).toBe("a:3");
    expect(calls).toBe(4);
    await Effect.runPromise(gate.dispose);
  });

  it("does not classify Effect failures or evict a retained result on failure", async () => {
    let fail = false;
    let decisions = 0;
    const gate = await Effect.runPromise(
      makeRequestGate((input: string) => (fail ? Effect.fail("offline") : Effect.succeed(input)), {
        key: String,
        shouldCache: () => {
          decisions++;
          return true;
        },
      }),
    );
    expect(await Effect.runPromise(gate.run("a"))).toBe("a");
    fail = true;
    const failed = await Effect.runPromise(Effect.either(gate.run("a", { force: true })));
    expect(failed).toEqual(Either.left("offline"));
    expect(await Effect.runPromise(gate.run("a"))).toBe("a");
    expect(decisions).toBe(1);
    await Effect.runPromise(gate.dispose);
  });

  it("completes shared callers and cleanup when the predicate throws", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const defect = new Error("retention predicate defect");
        let decisions = 0;
        const gate = yield* makeRequestGate(
          (input: string) =>
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release)), Effect.as(input)),
          {
            key: String,
            shouldCache: () => {
              if (++decisions === 1) throw defect;
              return true;
            },
          },
        );
        const owner = yield* Effect.fork(gate.run("a"));
        yield* Deferred.await(started);
        const waiter = yield* Effect.fork(gate.run("a"));
        yield* Effect.yieldNow();
        yield* Deferred.succeed(release, undefined);
        const ownerExit = yield* Fiber.await(owner);
        const waiterExit = yield* Fiber.await(waiter);
        expect(ownerExit).toEqual(Exit.die(defect));
        expect(waiterExit).toEqual(ownerExit);
        expect(yield* gate.run("a")).toBe("a");
        yield* gate.dispose;
      }),
    );
  });

  it("prevents superseded excluded completions from clearing the current retained value", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const gate = yield* makeRequestGate(
          (_input: string) =>
            ++calls === 2
              ? Effect.uninterruptible(
                  Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(release)), Effect.as(false)),
                )
              : Effect.succeed(true),
          { key: String, shouldCache: (value) => value },
        );
        expect(yield* gate.run("a")).toBe(true);
        const superseded = yield* Effect.fork(gate.run("a", { force: true }));
        yield* Deferred.await(started);
        expect(yield* gate.run("a", { force: true })).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(superseded);
        expect(yield* gate.run("a")).toBe(true);
        expect(calls).toBe(3);
        yield* gate.dispose;
      }),
    );
  });
});
