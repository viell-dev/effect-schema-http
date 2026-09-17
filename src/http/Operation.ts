import { HttpClient, HttpClientError, HttpClientRequest } from "@effect/platform";
import { Cause, Clock, Effect, Exit, Option, Pipeable, Schedule, Function } from "effect";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import * as Transport from "./Transport.js";

/** Operations return ordinary cold Effects, with complete input and environment types. */
export interface Operation<in I, out A, out E = never, out R = never> extends Pipeable.Pipeable {
  readonly execute: (input: I) => Effect.Effect<A, E, R>;
}

export const fromEffect = <I, A, E, R>(execute: Operation<I, A, E, R>["execute"]): Operation<I, A, E, R> => ({
  execute: (input) => Effect.suspend(() => execute(input)),
  pipe() {
    // eslint-disable-next-line prefer-rest-params -- Effect pipeArguments accepts IArguments.
    return Pipeable.pipeArguments(this, arguments);
  },
});

export interface Options<E = HttpClientError.HttpClientError, R = never, RP = never> {
  readonly policy?: Policy.Policy<RP>;
  /** Native client transforms run inside each attempt, suitable for nonces and signatures. */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient.With<E, R>;
}

export const make = <
  I,
  E,
  R,
  H extends boolean,
  Q extends boolean,
  A,
  E2,
  R2,
  E3 = HttpClientError.HttpClientError,
  R3 = never,
  RP = never,
>(
  request: Request.Request<I, E, R, H, Q>,
  response: Response.Response<A, E2, R2>,
  options?: Options<E3, R3, RP>,
): Operation<
  I,
  A,
  | E
  | E3
  | Request.InvalidRequest
  | HttpClientError.HttpClientError
  | Response.UnexpectedStatus
  | Response.DecodeError<E2 | HttpClientError.ResponseError>
  | Cause.TimeoutException,
  R | R2 | R3 | RP | HttpClient.HttpClient
> =>
  fromEffect((input) =>
    Effect.gen(function* () {
      const compiled = yield* Request.compile(request, input);
      let prepared = compiled.request;
      if (prepared.headers.accept === undefined && response.accepts.length > 0)
        prepared = HttpClientRequest.setHeader(prepared, "accept", response.accepts.join(", "));
      const client = yield* HttpClient.HttpClient;
      const policy = options?.policy ?? Policy.none;
      const driver = yield* Schedule.driver(policy.schedule);
      while (true) {
        let info: Option.Option<Response.Metadata> = Option.none();
        const attempt = Effect.scoped(
          Effect.gen(function* () {
            const activeClient: HttpClient.HttpClient.With<E3 | HttpClientError.HttpClientError, R3> =
              options?.transformClient?.(client) ?? client;
            // A fresh request identity isolates Platform's scoped abort-controller association.
            const fresh = HttpClientRequest.setHeaders(prepared, {});
            const received = yield* HttpClient.withScope(activeClient)
              .execute(fresh)
              .pipe(Effect.provideService(Transport.HeaderLines, compiled.headerLines));
            info = Option.some(Response.metadata(received));
            return yield* Response.decode(response, received);
          }),
        );
        const exit = yield* Effect.exit(
          policy.attemptTimeout === undefined ? attempt : Effect.timeout(attempt, policy.attemptTimeout),
        );
        if (Exit.isFailure(exit) && (Cause.isInterrupted(exit.cause) || Cause.isDie(exit.cause))) return yield* exit;
        const reason: Policy.Reason = Exit.isFailure(exit)
          ? { _tag: "Failure", cause: exit.cause, metadata: Option.getOrUndefined(info) }
          : { _tag: "Response", metadata: Option.getOrThrow(info) };
        if (!policy.while(reason)) return yield* exit;
        const now = yield* Clock.currentTimeMillis;
        const earliest =
          reason.metadata !== undefined && policy.retryAfter ? Policy.retryAfterTime(reason.metadata, now) : now;
        const next = yield* Effect.option(driver.next(reason));
        if (Option.isNone(next)) return yield* exit;
        const remaining = earliest - (yield* Clock.currentTimeMillis);
        if (remaining > 0) yield* Effect.sleep(remaining);
      }
    }),
  );

export const execute: {
  <I>(input: I): <A, E, R>(self: Operation<I, A, E, R>) => Effect.Effect<A, E, R>;
  <I, A, E, R>(self: Operation<I, A, E, R>, input: I): Effect.Effect<A, E, R>;
} = Function.dual(2, <I, A, E, R>(self: Operation<I, A, E, R>, input: I): Effect.Effect<A, E, R> =>
  self.execute(input),
);

export const map =
  <A, B>(f: (value: A) => B) =>
  <I, E, R>(self: Operation<I, A, E, R>): Operation<I, B, E, R> =>
    fromEffect((input) => Effect.map(self.execute(input), f));

export const mapEffect =
  <A, B, E2, R2>(f: (value: A) => Effect.Effect<B, E2, R2>) =>
  <I, E, R>(self: Operation<I, A, E, R>): Operation<I, B, E | E2, R | R2> =>
    fromEffect((input) => Effect.flatMap(self.execute(input), f));
