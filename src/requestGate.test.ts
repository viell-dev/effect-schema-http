import { Deferred, Effect, Either, Fiber, Option } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  invalidateRequestGate,
  makeRequestGate,
  NoPreviousRequest,
  refreshRequest,
  reloadRequest,
  runRequest,
} from "./main.js";

describe("RequestGate", () => {
  it("retains the latest successful input and supports refresh and reload", async () => {
    const calls: Array<{ readonly page: number; readonly search: string }> = [];
    const program = Effect.gen(function* () {
      const gate = yield* makeRequestGate(
        (input: { readonly page: number; readonly search: string }) =>
          Effect.sync(() => {
            calls.push(input);
            return { input, call: calls.length };
          }),
        { key: ({ page, search }) => `${page}:${search}` },
      );

      const first = yield* gate.pipe(runRequest({ page: 1, search: "ada" }));
      const reused = yield* gate.run({ page: 1, search: "ada" });
      const refreshed = yield* gate.pipe(refreshRequest({ page: 1, search: "ada" }));
      const reloaded = yield* gate.pipe(reloadRequest);
      const peeked = yield* gate.peek;

      return { first, reused, refreshed, reloaded, peeked };
    });

    const result = await Effect.runPromise(program);

    expect(result.first.call).toBe(1);
    expect(result.reused).toBe(result.first);
    expect(result.refreshed.call).toBe(2);
    expect(result.reloaded.call).toBe(3);
    expect(Option.getOrUndefined(result.peeked)).toBe(result.reloaded);
    expect(calls).toHaveLength(3);
  });

  it("does not let failed requests evict the last successful result or input", async () => {
    const calls: Array<string> = [];
    const program = Effect.gen(function* () {
      const gate = yield* makeRequestGate(
        (input: string) =>
          Effect.suspend(() => {
            calls.push(input);
            return input === "invalid" ? Effect.fail("invalid" as const) : Effect.succeed(`${input}:${calls.length}`);
          }),
        { key: (input) => input },
      );

      const good = yield* gate.run("good");
      const failure = yield* gate.run("invalid").pipe(Effect.either);
      const reused = yield* gate.run("good");
      const reloaded = yield* gate.reload;
      return { failure, good, reused, reloaded };
    });

    const result = await Effect.runPromise(program);

    expect(Either.isLeft(result.failure)).toBe(true);
    expect(result.reused).toBe(result.good);
    expect(result.reloaded).toBe("good:3");
    expect(calls).toEqual(["good", "invalid", "good"]);
  });

  it("coalesces equivalent in-flight requests", async () => {
    let calls = 0;
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = yield* makeRequestGate(
        (input: { readonly id: string }) =>
          Effect.gen(function* () {
            calls += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return input.id;
          }),
        { key: ({ id }) => id },
      );

      const first = yield* Effect.fork(gate.run({ id: "same" }));
      yield* Deferred.await(started);
      const second = yield* Effect.fork(gate.run({ id: "same" }));
      yield* Effect.yieldNow();
      yield* Deferred.succeed(release, undefined);

      return yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    });

    const results = await Effect.runPromise(program);

    expect(results).toEqual(["same", "same"]);
    expect(calls).toBe(1);
  });

  it("prevents stale completions and invalidated flights from repopulating the cache", async () => {
    const program = Effect.gen(function* () {
      const aStarted = yield* Deferred.make<void>();
      const bStarted = yield* Deferred.make<void>();
      const releaseA = yield* Deferred.make<void>();
      const releaseB = yield* Deferred.make<void>();
      const gate = yield* makeRequestGate(
        (input: "a" | "b") =>
          Effect.gen(function* () {
            yield* Deferred.succeed(input === "a" ? aStarted : bStarted, undefined);
            yield* Deferred.await(input === "a" ? releaseA : releaseB);
            return input;
          }),
        { key: (input) => input },
      );

      const a = yield* Effect.fork(gate.run("a"));
      yield* Deferred.await(aStarted);
      const b = yield* Effect.fork(gate.run("b"));
      yield* Deferred.await(bStarted);
      yield* Deferred.succeed(releaseB, undefined);
      yield* Fiber.join(b);
      yield* Deferred.succeed(releaseA, undefined);
      yield* Fiber.join(a);
      const afterStale = yield* gate.peek;

      const invalidatedStarted = yield* Deferred.make<void>();
      const invalidatedRelease = yield* Deferred.make<void>();
      const invalidatedGate = yield* makeRequestGate(
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(invalidatedStarted, undefined);
            yield* Deferred.await(invalidatedRelease);
            return "late";
          }),
        { key: () => "only" },
      );
      const late = yield* Effect.fork(invalidatedGate.run(undefined));
      yield* Deferred.await(invalidatedStarted);
      yield* invalidatedGate.pipe(invalidateRequestGate);
      yield* Deferred.succeed(invalidatedRelease, undefined);
      yield* Fiber.join(late);
      const afterInvalidation = yield* invalidatedGate.peek;

      return { afterStale, afterInvalidation };
    });

    const result = await Effect.runPromise(program);

    expect(Option.getOrUndefined(result.afterStale)).toBe("b");
    expect(Option.isNone(result.afterInvalidation)).toBe(true);
  });

  it("can retain an older success when every newer request failed", async () => {
    const program = Effect.gen(function* () {
      const aStarted = yield* Deferred.make<void>();
      const bStarted = yield* Deferred.make<void>();
      const releaseA = yield* Deferred.make<void>();
      const releaseB = yield* Deferred.make<void>();
      const gate = yield* makeRequestGate(
        (input: "a" | "b") =>
          Effect.gen(function* () {
            yield* Deferred.succeed(input === "a" ? aStarted : bStarted, undefined);
            yield* Deferred.await(input === "a" ? releaseA : releaseB);
            if (input === "b") return yield* Effect.fail("bad input" as const);
            return input;
          }),
        { key: (input) => input },
      );

      const a = yield* Effect.fork(gate.run("a"));
      yield* Deferred.await(aStarted);
      const b = yield* Effect.fork(gate.run("b"));
      yield* Deferred.await(bStarted);
      yield* Deferred.succeed(releaseB, undefined);
      yield* Fiber.await(b);
      yield* Deferred.succeed(releaseA, undefined);
      yield* Fiber.join(a);
      return yield* gate.peek;
    });

    const result = await Effect.runPromise(program);
    expect(Option.getOrUndefined(result)).toBe("a");
  });

  it("cleans up an in-flight entry when its executing fiber is interrupted", async () => {
    let calls = 0;
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      const gate = yield* makeRequestGate(
        () =>
          Effect.gen(function* () {
            calls += 1;
            if (calls === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(never);
            }
            return "recovered";
          }),
        { key: () => "only" },
      );

      const interrupted = yield* Effect.fork(gate.run(undefined));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(interrupted);
      return yield* gate.run(undefined);
    });

    const result = await Effect.runPromise(program);
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("fails reload before the first successful request", () => {
    const program = Effect.gen(function* () {
      const gate = yield* makeRequestGate((input: number) => Effect.succeed(input), { key: (input) => input });
      expectTypeOf(gate.reload).toEqualTypeOf<Effect.Effect<number, NoPreviousRequest>>();
      return yield* gate.reload.pipe(Effect.either);
    });

    const result = Effect.runSync(program);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(NoPreviousRequest);
  });
});
