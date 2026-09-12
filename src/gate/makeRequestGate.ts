import { Deferred, Effect, Exit, Ref } from "effect";
import { GateClosed } from "../errors/GateClosed.js";
import type { RequestGate, RequestGateOptions, RequestGateRunOptions } from "./types.js";

interface Flight<Key, A, E> {
  readonly key: Key;
  readonly result: Deferred.Deferred<A, E>;
  readonly cancellation: Deferred.Deferred<void>;
}

interface State<Key, A, E> {
  readonly closed: boolean;
  readonly cached: { readonly key: Key; readonly value: A } | undefined;
  readonly active: Flight<Key, A, E> | undefined;
  /** Superseded executions remain owned until their finalizers complete. */
  readonly flights: ReadonlyArray<Flight<Key, A, E>>;
}

type Decision<Key, A, E> =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Join"; readonly flight: Flight<Key, A, E> }
  | { readonly _tag: "Cached"; readonly value: A; readonly previous: Flight<Key, A, E> | undefined }
  | { readonly _tag: "Execute"; readonly previous: Flight<Key, A, E> | undefined };

/**
 * Allocates one interaction gate. Different input automatically interrupts previous work, including before cache hits.
 * Equal inputs join active work. Force bypasses both reuse paths. Values and keys must be treated as immutable.
 * The initiating fiber owns execution; interrupting a joining waiter does not interrupt that owner.
 */
export const makeRequestGate = <Input, Key, A, E, R>(
  execute: (input: Input) => Effect.Effect<A, E, R>,
  options: RequestGateOptions<Input, Key>,
): Effect.Effect<RequestGate<Input, A, E, R>> =>
  Effect.gen(function* () {
    const equivalent = options.equivalent ?? Object.is;
    const state = yield* Ref.make<State<Key, A, E>>({
      closed: false,
      cached: undefined,
      active: undefined,
      flights: [],
    });
    const disposed = yield* Deferred.make<void>();

    const run = (input: Input, runOptions: RequestGateRunOptions = {}): Effect.Effect<A, E | GateClosed, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const key = options.key(input);
          const candidate: Flight<Key, A, E> = {
            key,
            result: yield* Deferred.make<A, E>(),
            cancellation: yield* Deferred.make<void>(),
          };
          const decision = yield* Ref.modify(state, (current): readonly [Decision<Key, A, E>, State<Key, A, E>] => {
            if (current.closed) return [{ _tag: "Closed" } as const, current] as const;
            if (!runOptions.force && current.active !== undefined && equivalent(current.active.key, key)) {
              return [{ _tag: "Join", flight: current.active } as const, current] as const;
            }
            const previous = current.active;
            if (!runOptions.force && current.cached !== undefined && equivalent(current.cached.key, key)) {
              return [
                { _tag: "Cached", value: current.cached.value, previous } as const,
                { ...current, active: undefined },
              ] as const;
            }
            return [
              { _tag: "Execute", previous } as const,
              { ...current, active: candidate, flights: [...current.flights, candidate] },
            ] as const;
          });
          if (decision._tag === "Closed") return yield* new GateClosed();
          if (decision._tag === "Join") return yield* restore(Deferred.await(decision.flight.result));
          if (decision.previous !== undefined) yield* Deferred.succeed(decision.previous.cancellation, undefined);
          if (decision._tag === "Cached") return decision.value;

          const result = yield* Effect.exit(
            restore(
              Effect.raceFirst(
                Effect.suspend(() => execute(input)),
                Deferred.await(candidate.cancellation).pipe(Effect.zipRight(Effect.interrupt)),
              ),
            ),
          );
          yield* Ref.update(state, (current) => ({
            ...current,
            cached:
              !current.closed && current.active === candidate && Exit.isSuccess(result)
                ? { key, value: result.value }
                : current.cached,
            active: current.active === candidate ? undefined : current.active,
            flights: current.flights.filter((flight) => flight !== candidate),
          }));
          yield* Deferred.done(candidate.result, result);
          return yield* result;
        }),
      );

    const dispose = Effect.uninterruptible(
      Effect.gen(function* () {
        const closing = yield* Ref.modify(state, (current) =>
          current.closed
            ? ([undefined, current] as const)
            : ([current.flights, { ...current, closed: true, cached: undefined, active: undefined }] as const),
        );
        if (closing === undefined) return yield* Deferred.await(disposed);
        yield* Effect.forEach(closing, (flight) => Deferred.succeed(flight.cancellation, undefined), { discard: true });
        yield* Effect.forEach(closing, (flight) => Effect.exit(Deferred.await(flight.result)), { discard: true });
        yield* Deferred.succeed(disposed, undefined);
      }),
    );
    return { run, dispose };
  });
