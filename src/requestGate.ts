import { Data, Deferred, Effect, Exit, Option, Ref } from "effect";
import type * as Pipeable from "effect/Pipeable";

const pipeSelf = function (this: unknown, ...operations: ReadonlyArray<(value: unknown) => unknown>): unknown {
  return operations.reduce<unknown>((value, operation) => operation(value), this);
} as Pipeable.Pipeable["pipe"];

export class NoPreviousRequest extends Data.TaggedError("NoPreviousRequest") {}

export interface RequestGateOptions<Input, Key> {
  readonly key: (input: Input) => Key;
  readonly equivalent?: (left: Key, right: Key) => boolean;
}

export interface RequestGate<Input, A, E, R> extends Pipeable.Pipeable {
  readonly run: (input: Input) => Effect.Effect<A, E, R>;
  readonly refresh: (input: Input) => Effect.Effect<A, E, R>;
  readonly reload: Effect.Effect<A, E | NoPreviousRequest, R>;
  readonly invalidate: Effect.Effect<void>;
  readonly peek: Effect.Effect<Option.Option<A>>;
}

interface CacheEntry<Input, Key, A> {
  readonly input: Input;
  readonly key: Key;
  readonly value: A;
  readonly generation: number;
}

interface InFlight<Input, Key, A, E> {
  readonly input: Input;
  readonly key: Key;
  readonly generation: number;
  readonly deferred: Deferred.Deferred<A, E>;
  readonly cancellation: Deferred.Deferred<void>;
}

interface GateState<Input, Key, A, E> {
  readonly cache: Option.Option<CacheEntry<Input, Key, A>>;
  readonly inFlight: ReadonlyArray<InFlight<Input, Key, A, E>>;
  readonly generation: number;
  readonly invalidatedThrough: number;
}

type Decision<Input, Key, A, E> =
  | { readonly _tag: "Cached"; readonly value: A }
  | { readonly _tag: "Await"; readonly deferred: Deferred.Deferred<A, E> }
  | { readonly _tag: "Execute"; readonly flight: InFlight<Input, Key, A, E> };

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
          const result = yield* Effect.exit(restore(Effect.raceFirst(execute(input), cancelled)));
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

export const runRequest =
  <Input>(input: Input) =>
  <A, E, R>(gate: RequestGate<Input, A, E, R>): Effect.Effect<A, E, R> =>
    gate.run(input);

export const refreshRequest =
  <Input>(input: Input) =>
  <A, E, R>(gate: RequestGate<Input, A, E, R>): Effect.Effect<A, E, R> =>
    gate.refresh(input);

export const reloadRequest = <Input, A, E, R>(
  gate: RequestGate<Input, A, E, R>,
): Effect.Effect<A, E | NoPreviousRequest, R> => gate.reload;

export const invalidateRequestGate = <Input, A, E, R>(gate: RequestGate<Input, A, E, R>): Effect.Effect<void> =>
  gate.invalidate;
