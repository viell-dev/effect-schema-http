import {
  Context,
  Data,
  Deferred,
  Effect,
  Equal,
  type Equivalence,
  Exit,
  type Fiber,
  Scope,
  Semaphore,
} from "effect";

/** The interaction was closed; it admits no further work. */
export class Closed extends Data.TaggedError("InteractionClosed") {}

export interface RunOptions {
  /** Start fresh work, superseding active work and bypassing the retained result. */
  readonly force?: boolean | undefined;
}

/** One user-facing interaction: at most one active execution and one retained success. */
export interface Interaction<in I, out A, out E = never> {
  /** Equal input joins active work or reuses the retained success; different input supersedes active work. */
  readonly run: (
    input: I,
    options?: RunOptions,
  ) => Effect.Effect<A, E | Closed>;
  /** Permanent and idempotent. Every caller waits for all owned finalizers, including superseded work. */
  readonly close: Effect.Effect<void>;
}

export interface Options<I, A> {
  /** Defaults to `Equal.equals`, which compares plain objects and arrays structurally. */
  readonly equivalence?: Equivalence.Equivalence<I> | undefined;
  /** Whether a successful result is retained for reuse. The result is returned either way. */
  readonly retain?: ((value: A, input: I) => boolean) | undefined;
}

interface Flight<I, A, E> {
  readonly input: I;
  readonly result: Deferred.Deferred<A, E>;
  readonly fiber: Fiber.Fiber<void>;
}

/**
 * Acquire an interaction in the current Scope. Services are captured at acquisition, like a Layer. Every
 * execution belongs to the interaction rather than to a caller, and runs in its own child Scope, so
 * interrupting one waiter never cancels work another waiter shares.
 */
export const make = Effect.fnUntraced(function* <I, A, E, R>(
  execute: (input: I) => Effect.Effect<A, E, R>,
  options?: Options<I, A>,
): Effect.fn.Return<Interaction<I, A, E>, never, R | Scope.Scope> {
  const context = yield* Effect.context<R>();
  const owned = yield* Scope.make("parallel");
  const lock = yield* Semaphore.make(1);
  const closing = yield* Deferred.make<void>();
  const equivalent = options?.equivalence ?? Equal.equals;
  let closed = false;
  let flight: Flight<I, A, E> | undefined;
  let retained: { readonly input: I; readonly value: A } | undefined;

  const close = Effect.uninterruptible(
    Effect.gen(function* () {
      const first = yield* lock.withPermit(
        Effect.sync(() => {
          if (closed) return false;
          closed = true;
          flight = undefined;
          retained = undefined;
          return true;
        }),
      );
      if (first)
        yield* Deferred.done(
          closing,
          yield* Effect.exit(Scope.close(owned, Exit.void)),
        );
      yield* Deferred.await(closing);
    }),
  );
  yield* Effect.addFinalizer(() => close);

  // State transitions hold the lock briefly; it is never held while waiting for work or finalizers.
  const publish = (
    input: I,
    shared: Deferred.Deferred<A, E>,
    exit: Exit.Exit<A, E>,
  ) =>
    lock.withPermit(
      Effect.sync(() => {
        if (flight?.result !== shared) return;
        try {
          if (Exit.isSuccess(exit)) {
            if (options?.retain?.(exit.value, input) ?? true)
              retained = { input, value: exit.value };
            else if (
              retained !== undefined &&
              equivalent(retained.input, input)
            )
              retained = undefined;
          }
        } finally {
          flight = undefined;
        }
      }),
    );

  // Forked uninterruptibly so that publication always happens, even when superseded before starting.
  const worker = Effect.fnUntraced(function* (
    input: I,
    shared: Deferred.Deferred<A, E>,
  ) {
    const exit = yield* Effect.exit(
      Effect.interruptible(
        Effect.scopedWith((scope) =>
          Effect.suspend(() => execute(input)).pipe(
            Effect.provideContext(Context.add(context, Scope.Scope, scope)),
          ),
        ),
      ),
    );
    // A retention predicate defect still releases every waiter and clears the active flight.
    const publication = yield* Effect.exit(publish(input, shared, exit));
    yield* Deferred.done(
      shared,
      Exit.isFailure(publication) ? Exit.failCause(publication.cause) : exit,
    );
  });

  const admit = Effect.fnUntraced(function* (input: I, force: boolean) {
    if (closed) return yield* new Closed();
    if (!force && flight !== undefined && equivalent(flight.input, input))
      return Deferred.await(flight.result);
    if (flight !== undefined) {
      flight.fiber.interruptUnsafe();
      flight = undefined;
    }
    if (!force && retained !== undefined && equivalent(retained.input, input))
      return Effect.succeed(retained.value);
    const shared = yield* Deferred.make<A, E>();
    const fiber = yield* Effect.forkIn(worker(input, shared), owned, {
      uninterruptible: true,
    });
    flight = { input, result: shared, fiber };
    return Deferred.await(shared);
  });

  const run = (input: I, settings?: RunOptions): Effect.Effect<A, E | Closed> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        lock.withPermit(admit(input, settings?.force === true)),
        (result) => restore(result),
      ),
    );

  return { run, close };
});
