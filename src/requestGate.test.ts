/** Unit tests for request-gate caching, sharing, refresh, reload, and interruption semantics. */
import { Cause, Deferred, Effect, Either, Exit, Fiber, Option } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  cancelRequestGate,
  invalidateRequestGate,
  makeRequestGate,
  NoPreviousRequest,
  refreshRequest,
  reloadRequest,
  runRequest,
} from "./main.js";

describe("RequestGate", () => {
  it("keeps a shared execution alive when only a waiter is interrupted", async () => {
    let calls = 0;
    const result = await Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = yield* makeRequestGate(
        () =>
          Effect.gen(function* () {
            calls += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return "done";
          }),
        { key: () => "same" },
      );
      const owner = yield* Effect.fork(gate.run(undefined));
      yield* Deferred.await(started);
      const waiter = yield* Effect.fork(gate.run(undefined));
      yield* Effect.yieldNow();
      const waiterExit = yield* Fiber.interrupt(waiter);
      yield* Deferred.succeed(release, undefined);
      const value = yield* Fiber.join(owner);
      return { waiterExit, value, cached: yield* gate.peek };
    }).pipe(Effect.runPromise);

    expect(Exit.isFailure(result.waiterExit) && Cause.isInterruptedOnly(result.waiterExit.cause)).toBe(true);
    expect(result.value).toBe("done");
    expect(result.cached).toEqual(Option.some("done"));
    expect(calls).toBe(1);
  });

  it("starts separate refreshes while run can still return the prior cached success", async () => {
    let calls = 0;
    const result = await Effect.gen(function* () {
      const bothStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = yield* makeRequestGate(
        () =>
          Effect.gen(function* () {
            const call = ++calls;
            if (call === 3) yield* Deferred.succeed(bothStarted, undefined);
            if (call > 1) yield* Deferred.await(release);
            return call;
          }),
        { key: () => "same" },
      );
      yield* gate.run(undefined);
      const first = yield* Effect.fork(gate.refresh(undefined));
      const second = yield* Effect.fork(gate.refresh(undefined));
      yield* Deferred.await(bothStarted);
      const duringRefresh = yield* gate.run(undefined);
      yield* Deferred.succeed(release, undefined);
      const refreshed = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      return { duringRefresh, refreshed, cached: yield* gate.peek };
    }).pipe(Effect.runPromise);

    expect(result.duringRefresh).toBe(1);
    expect(result.refreshed).toEqual([2, 3]);
    expect(result.cached).toEqual(Option.some(3));
    expect(calls).toBe(3);
  });

  it("stays lazy and cleans up when constructing the request Effect throws", async () => {
    let calls = 0;
    const defect = new Error("request construction failed");
    const result = await Effect.gen(function* () {
      const gate = yield* makeRequestGate(
        (input: string) => {
          calls += 1;
          if (calls === 1) throw defect;
          return Effect.succeed(input);
        },
        { key: (input) => input },
      );
      const request = gate.run("same");
      expect(calls).toBe(0);
      const failed = yield* Effect.exit(request);
      const recovered = yield* request.pipe(Effect.timeout("100 millis"), Effect.exit);
      return { failed, recovered };
    }).pipe(Effect.runPromise);

    expect(Exit.isFailure(result.failed) && Array.from(Cause.defects(result.failed.cause)).includes(defect)).toBe(true);
    expect(result.recovered).toEqual(Exit.succeed("same"));
    expect(calls).toBe(2);
  });

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

  it("prevents stale completions and interrupts invalidated flights", async () => {
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
      let interrupted = false;
      const invalidatedGate = yield* makeRequestGate(
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(invalidatedStarted, undefined);
            yield* Effect.never;
            return "late";
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        { key: () => "only" },
      );
      const late = yield* Effect.fork(invalidatedGate.run(undefined));
      yield* Deferred.await(invalidatedStarted);
      const waiter = yield* Effect.fork(invalidatedGate.run(undefined));
      yield* Effect.yieldNow();
      yield* invalidatedGate.pipe(invalidateRequestGate);
      const lateExit = yield* Fiber.await(late);
      const waiterExit = yield* Fiber.await(waiter);
      const afterInvalidation = yield* invalidatedGate.peek;

      return { afterStale, afterInvalidation, interrupted, lateExit, waiterExit };
    });

    const result = await Effect.runPromise(program);

    expect(Option.getOrUndefined(result.afterStale)).toBe("b");
    expect(Option.isNone(result.afterInvalidation)).toBe(true);
    expect(result.interrupted).toBe(true);
    expect(Exit.isFailure(result.lateExit) && Cause.isInterruptedOnly(result.lateExit.cause)).toBe(true);
    expect(Exit.isFailure(result.waiterExit) && Cause.isInterruptedOnly(result.waiterExit.cause)).toBe(true);
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

  it("interrupts current flights while retaining the cached success", async () => {
    let calls = 0;
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let interrupted = false;
      const gate = yield* makeRequestGate(
        (input: string) =>
          Effect.gen(function* () {
            calls += 1;
            if (input === "cached") return input;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return input;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        { key: (input) => input },
      );

      yield* gate.run("cached");
      const superseded = yield* Effect.fork(gate.run("superseded"));
      yield* Deferred.await(started);
      const waiter = yield* Effect.fork(gate.run("superseded"));
      yield* Effect.yieldNow();

      yield* gate.pipe(cancelRequestGate);

      const supersededExit = yield* Fiber.await(superseded);
      const waiterExit = yield* Fiber.await(waiter);
      const afterCancel = yield* gate.peek;

      // The retained success is still reusable without another execution.
      const reused = yield* gate.run("cached");

      // A cancelled flight completing late cannot resurrect its own value.
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow();
      const afterLateCompletion = yield* gate.peek;

      return { afterCancel, afterLateCompletion, interrupted, reused, supersededExit, waiterExit };
    });

    const result = await Effect.runPromise(program);

    expect(Option.getOrUndefined(result.afterCancel)).toBe("cached");
    expect(Option.getOrUndefined(result.afterLateCompletion)).toBe("cached");
    expect(result.reused).toBe("cached");
    expect(result.interrupted).toBe(true);
    expect(calls).toBe(2);
    expect(Exit.isFailure(result.supersededExit) && Cause.isInterruptedOnly(result.supersededExit.cause)).toBe(true);
    expect(Exit.isFailure(result.waiterExit) && Cause.isInterruptedOnly(result.waiterExit.cause)).toBe(true);
  });

  it("can reload the retained input after cancelling its successor", async () => {
    const program = Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* makeRequestGate(
        (input: string) =>
          input === "slow"
            ? Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never), Effect.as(input))
            : Effect.succeed(input),
        { key: (input) => input },
      );

      yield* gate.run("first");
      const slow = yield* Effect.fork(gate.run("slow"));
      yield* Deferred.await(started);
      yield* gate.cancel;
      yield* Fiber.await(slow);

      return yield* gate.reload;
    });

    await expect(Effect.runPromise(program)).resolves.toBe("first");
  });
});
