/**
 * Single-entry request memoization with in-flight de-duplication.
 *
 * @packageDocumentation
 */
import { Data, Deferred, Effect, Exit, Option, Ref } from "effect";
import type * as Pipeable from "effect/Pipeable";

/** Applies pipeable operations to the current value. */
const pipeSelf = function (this: unknown, ...operations: ReadonlyArray<(value: unknown) => unknown>): unknown {
  return operations.reduce<unknown>((value, operation) => operation(value), this);
} as Pipeable.Pipeable["pipe"];

/**
 * Indicates that a gate has no successful request available to reload.
 *
 * @public
 */
export class NoPreviousRequest extends Data.TaggedError("NoPreviousRequest") {}

/**
 * Configuration for deriving and comparing request-gate keys.
 *
 * @typeParam Input - Input accepted by the gated request.
 * @typeParam Key - Comparable memoization key derived from the input.
 * @public
 */
export interface RequestGateOptions<Input, Key> {
  /** Derives the memoization key when a request Effect runs. Must be pure and include all relevant input fields. */
  readonly key: (input: Input) => Key;
  /** Compares keys. Defaults to {@link Object.is}. */
  readonly equivalent?: (left: Key, right: Key) => boolean;
}

/**
 * A single-entry request gate with explicit refresh, reload, and invalidation operations.
 *
 * @typeParam Input - Input accepted by the request.
 * @typeParam A - Successful request value.
 * @typeParam E - Request error.
 * @typeParam R - Effect requirements needed to execute the request.
 * @public
 */
export interface RequestGate<Input, A, E, R> extends Pipeable.Pipeable {
  /** Returns an equivalent cached success first, otherwise joins an equivalent flight or executes the request. */
  readonly run: (input: Input) => Effect.Effect<A, E, R>;
  /** Starts a separate execution, bypassing both cached successes and equivalent in-flight requests. */
  readonly refresh: (input: Input) => Effect.Effect<A, E, R>;
  /** Starts a separate execution of the latest successful input, or fails with {@link NoPreviousRequest}. */
  readonly reload: Effect.Effect<A, E | NoPreviousRequest, R>;
  /** Clears the cached success and signals interruption of current flights; does not await their finalizers. */
  readonly invalidate: Effect.Effect<void>;
  /** Reads the cached success without executing a request. */
  readonly peek: Effect.Effect<Option.Option<A>>;
}

/** A successful value retained by a gate. */
interface CacheEntry<Input, Key, A> {
  readonly input: Input;
  readonly key: Key;
  readonly value: A;
  readonly generation: number;
}

/** An executing request shared by equivalent callers. */
interface InFlight<Input, Key, A, E> {
  readonly input: Input;
  readonly key: Key;
  readonly generation: number;
  readonly deferred: Deferred.Deferred<A, E>;
  readonly cancellation: Deferred.Deferred<void>;
}

/** Complete mutable state stored atomically in the gate Ref. */
interface GateState<Input, Key, A, E> {
  readonly cache: Option.Option<CacheEntry<Input, Key, A>>;
  readonly inFlight: ReadonlyArray<InFlight<Input, Key, A, E>>;
  readonly generation: number;
  readonly invalidatedThrough: number;
}

/** Atomic decision made for one request attempt. */
type Decision<Input, Key, A, E> =
  | { readonly _tag: "Cached"; readonly value: A }
  | { readonly _tag: "Await"; readonly deferred: Deferred.Deferred<A, E> }
  | { readonly _tag: "Execute"; readonly flight: InFlight<Input, Key, A, E> };

/** Finds the newest equivalent request that callers may safely join. */
const findLatestEquivalent = <Input, Key, A, E>(
  inFlight: ReadonlyArray<InFlight<Input, Key, A, E>>,
  key: Key,
  equivalent: (left: Key, right: Key) => boolean,
): InFlight<Input, Key, A, E> | undefined => {
  for (let index = inFlight.length - 1; index >= 0; index -= 1) {
    const candidate = inFlight[index];
    if (candidate !== undefined && equivalent(candidate.key, key)) return candidate;
  }
  return undefined;
};

/**
 * Creates an isolated, single-entry request gate.
 *
 * @remarks
 * Equivalent concurrent `run` calls share one execution when no equivalent success is cached. `refresh` and `reload`
 * always start separate executions. Inputs and results are retained by reference and must be treated as immutable.
 * Invalidation signals interruption of all current executions. The fiber that
 * wins the execute decision owns the shared execution; interrupting that fiber completes its waiters as interrupted.
 * Interrupting a waiter only stops that waiter. Throws from `execute` become defects and still release shared waiters
 * and remove the in-flight entry, allowing subsequent calls to retry.
 *
 * @typeParam Input - Input accepted by the request.
 * @typeParam Key - Memoization key derived from an input.
 * @typeParam A - Successful request value.
 * @typeParam E - Request error.
 * @typeParam R - Effect requirements needed to execute the request.
 * @param execute - Effectful request function to memoize.
 * @param options - Key derivation and optional key equivalence.
 * @returns An Effect that allocates a new request gate.
 * @public
 */
export const makeRequestGate = <Input, Key, A, E, R>(
  execute: (input: Input) => Effect.Effect<A, E, R>,
  options: RequestGateOptions<Input, Key>,
): Effect.Effect<RequestGate<Input, A, E, R>> =>
  Effect.gen(function* () {
    const equivalent = options.equivalent ?? Object.is;
    const stateRef = yield* Ref.make<GateState<Input, Key, A, E>>({
      cache: Option.none(),
      inFlight: [],
      generation: 0,
      invalidatedThrough: 0,
    });

    const request = (input: Input, force: boolean): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const key = options.key(input);
          const candidate = yield* Deferred.make<A, E>();
          const cancellation = yield* Deferred.make<void>();
          const decision = yield* Ref.modify(
            stateRef,
            (state): readonly [Decision<Input, Key, A, E>, GateState<Input, Key, A, E>] => {
              if (!force && Option.isSome(state.cache) && equivalent(state.cache.value.key, key)) {
                return [{ _tag: "Cached", value: state.cache.value.value }, state];
              }

              if (!force) {
                const existing = findLatestEquivalent(state.inFlight, key, equivalent);
                if (existing !== undefined) return [{ _tag: "Await", deferred: existing.deferred }, state];
              }

              const generation = state.generation + 1;
              const flight = { input, key, generation, deferred: candidate, cancellation };
              return [
                { _tag: "Execute", flight },
                {
                  ...state,
                  inFlight: [...state.inFlight, flight],
                  generation,
                },
              ];
            },
          );

          if (decision._tag === "Cached") return decision.value;
          if (decision._tag === "Await") return yield* restore(Deferred.await(decision.deferred));

          const cancelled = Deferred.await(decision.flight.cancellation).pipe(Effect.zipRight(Effect.interrupt));
          const result = yield* Effect.exit(
            restore(
              Effect.raceFirst(
                Effect.suspend(() => execute(input)),
                cancelled,
              ),
            ),
          );
          yield* Ref.update(stateRef, (state) => ({
            ...state,
            cache:
              Exit.isSuccess(result) &&
              decision.flight.generation > state.invalidatedThrough &&
              (Option.isNone(state.cache) || decision.flight.generation > state.cache.value.generation)
                ? Option.some({ input, key, value: result.value, generation: decision.flight.generation })
                : state.cache,
            inFlight: state.inFlight.filter((flight) => flight.generation !== decision.flight.generation),
          }));
          yield* Deferred.done(decision.flight.deferred, result);

          return yield* Exit.match(result, {
            onFailure: (cause) => Effect.failCause(cause),
            onSuccess: (value) => Effect.succeed(value),
          });
        }),
      );

    const reload = Ref.get(stateRef).pipe(
      Effect.flatMap((state): Effect.Effect<A, E | NoPreviousRequest, R> =>
        Option.match(state.cache, {
          onNone: () => Effect.fail(new NoPreviousRequest()),
          onSome: ({ input }) => request(input, true),
        }),
      ),
    );

    const invalidate = Ref.modify(
      stateRef,
      (state) =>
        [
          state.inFlight.map(({ cancellation }) => cancellation),
          {
            ...state,
            cache: Option.none(),
            inFlight: [],
            invalidatedThrough: state.generation,
          },
        ] as const,
    ).pipe(
      Effect.flatMap((cancellations) =>
        Effect.forEach(cancellations, (cancellation) => Deferred.succeed(cancellation, undefined), { discard: true }),
      ),
      Effect.asVoid,
      Effect.uninterruptible,
    );

    const gate = {
      pipe: pipeSelf,
      run: (input: Input) => request(input, false),
      refresh: (input: Input) => request(input, true),
      reload,
      invalidate,
      peek: Ref.get(stateRef).pipe(Effect.map((state) => Option.map(state.cache, ({ value }) => value))),
    } satisfies RequestGate<Input, A, E, R>;

    return gate;
  });

/**
 * Pipeable form of {@link RequestGate.run}.
 *
 * @param input - Request input.
 * @returns A transformation from a gate to its gated request Effect.
 * @public
 */
export const runRequest =
  <Input>(input: Input) =>
  <A, E, R>(gate: RequestGate<Input, A, E, R>): Effect.Effect<A, E, R> =>
    gate.run(input);

/**
 * Pipeable form of {@link RequestGate.refresh}.
 *
 * @param input - Request input.
 * @returns A transformation from a gate to a forced request Effect.
 * @public
 */
export const refreshRequest =
  <Input>(input: Input) =>
  <A, E, R>(gate: RequestGate<Input, A, E, R>): Effect.Effect<A, E, R> =>
    gate.refresh(input);

/**
 * Pipeable form of {@link RequestGate.reload}.
 *
 * @param gate - Gate whose latest successful input should be executed again.
 * @returns The reload Effect.
 * @public
 */
export const reloadRequest = <Input, A, E, R>(
  gate: RequestGate<Input, A, E, R>,
): Effect.Effect<A, E | NoPreviousRequest, R> => gate.reload;

/**
 * Pipeable form of {@link RequestGate.invalidate}.
 *
 * @param gate - Gate to clear and interrupt.
 * @returns An Effect that invalidates the gate.
 * @public
 */
export const invalidateRequestGate = <Input, A, E, R>(gate: RequestGate<Input, A, E, R>): Effect.Effect<void> =>
  gate.invalidate;
