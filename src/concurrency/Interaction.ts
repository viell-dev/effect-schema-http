import { Data, Deferred, Effect, Equal, Equivalence, ExecutionStrategy, Exit, Fiber, Option, Scope } from "effect";

export class Closed extends Data.TaggedError("InteractionClosed") {}

export interface Interaction<in I, out A, out E = never> {
  /** Equal input joins or reuses. Force always starts fresh work. */
  readonly run: (input: I, options?: { readonly force?: boolean }) => Effect.Effect<A, E | Closed>;
  /** Permanent and idempotent. Every caller waits for all owned finalizers. */
  readonly close: Effect.Effect<void>;
}

export interface Options<I, A> {
  readonly equivalence?: Equivalence.Equivalence<I>;
  readonly retain?: (value: A, input: I) => boolean;
}

interface Flight<I, A, E> {
  readonly input: I;
  readonly result: Deferred.Deferred<A, E>;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
}

/**
 * Captures dependencies at acquisition, like a service layer. All workers belong to the acquisition
 * scope, never to an individual waiter. Canceling one waiter therefore cannot cancel another's work.
 */
export const make = <I, A, E, R>(
  execute: (input: I) => Effect.Effect<A, E, R>,
  options?: Options<I, A>,
): Effect.Effect<Interaction<I, A, E>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const owned = yield* Scope.make(ExecutionStrategy.parallel);
    const lock = yield* Effect.makeSemaphore(1);
    const closedResult = yield* Deferred.make<void>();
    const equivalent = options?.equivalence ?? Equal.equals;
    let closed = false;
    let flight: Option.Option<Flight<I, A, E>> = Option.none();
    let retained: Option.Option<{ readonly input: I; readonly value: A }> = Option.none();

    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        const first = yield* lock.withPermits(1)(
          Effect.sync(() => {
            if (closed) return false;
            closed = true;
            flight = Option.none();
            retained = Option.none();
            return true;
          }),
        );
        if (first) {
          const exit = yield* Effect.exit(Scope.close(owned, Exit.void));
          yield* Deferred.done(closedResult, exit);
        }
        yield* Deferred.await(closedResult);
      }),
    );
    yield* Effect.addFinalizer(() => close);

    const run = (input: I, settings?: { readonly force?: boolean }): Effect.Effect<A, E | Closed> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (closed) return yield* new Closed();
              if (!settings?.force && Option.isSome(flight) && equivalent(flight.value.input, input))
                return Deferred.await(flight.value.result);
              if (Option.isSome(flight)) {
                yield* Fiber.interruptFork(flight.value.fiber);
                flight = Option.none();
              }
              if (!settings?.force && Option.isSome(retained) && equivalent(retained.value.input, input))
                return Effect.succeed(retained.value.value);
              const shared = yield* Deferred.make<A, E>();
              const worker = Effect.uninterruptibleMask((resume) =>
                Effect.gen(function* () {
                  const exit = yield* Effect.exit(
                    resume(Effect.suspend(() => execute(input)).pipe(Effect.provide(context))),
                  );
                  // Predicate defects are captured too. Publishing and releasing admission must always happen.
                  const publication = yield* Effect.exit(
                    lock.withPermits(1)(
                      Effect.sync(() => {
                        if (Option.isSome(flight) && flight.value.result === shared) {
                          try {
                            if (Exit.isSuccess(exit)) {
                              if (options?.retain?.(exit.value, input) ?? true)
                                retained = Option.some({ input, value: exit.value });
                              else if (Option.isSome(retained) && equivalent(retained.value.input, input))
                                retained = Option.none();
                            }
                          } finally {
                            flight = Option.none();
                          }
                        }
                        return exit;
                      }),
                    ),
                  );
                  yield* Deferred.done(
                    shared,
                    Exit.isFailure(publication) ? Exit.failCause(publication.cause) : publication.value,
                  );
                }),
              );
              const fiber = yield* Effect.forkIn(Effect.interruptible(worker), owned);
              flight = Option.some({ input, result: shared, fiber });
              return Deferred.await(shared);
            }),
          );
          return yield* restore(result);
        }),
      );
    return { run, close };
  });
