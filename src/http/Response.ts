import { Cookies, Headers, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Data, Effect, Option, Pipeable } from "effect";
import * as Body from "./Body.js";
import * as Transport from "./Transport.js";

/** Deliberately excludes all body readers. Predicates cannot consume the body. */
export interface Metadata {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly cookies: Cookies.Cookies;
  /** Provider-observed lines, if available. Normalized headers are always available separately. */
  readonly headerLines: Option.Option<Transport.Lines>;
}

export class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{ readonly metadata: Metadata }> {}
export class DecodeError<E> extends Data.TaggedError("DecodeError")<{
  readonly metadata: Metadata;
  readonly cause: E;
}> {}

export interface Response<out A, out E = never, out R = never> extends Pipeable.Pipeable {
  readonly select: (metadata: Metadata) => Option.Option<Body.Decoder<A, E, R>>;
  readonly accepts: ReadonlyArray<string>;
}

export const metadata = (response: HttpClientResponse.HttpClientResponse): Metadata => ({
  status: response.status,
  headers: response.headers,
  cookies: response.cookies,
  headerLines: Transport.responseHeaderLines(response),
});

const make = <A, E, R>(select: Response<A, E, R>["select"], accepts: ReadonlyArray<string>): Response<A, E, R> => ({
  select,
  accepts,
  pipe() {
    // eslint-disable-next-line prefer-rest-params -- Effect pipeArguments accepts IArguments.
    return Pipeable.pipeArguments(this, arguments);
  },
});

export const when = <A, E, R>(
  predicate: (metadata: Metadata) => boolean,
  body: Body.Decoder<A, E, R>,
): Response<A, E, R> =>
  make(
    (info) => (predicate(info) ? Option.some(body) : Option.none()),
    body.mediaType === undefined ? [] : [body.mediaType],
  );

export const status = <A, E, R>(code: number, body: Body.Decoder<A, E, R>): Response<A, E, R> =>
  when((info) => info.status === code, body);

/** Declaration order is priority. Consult the fallback only for unmatched metadata. */
export const orElse =
  <B, E2, R2>(that: Response<B, E2, R2>) =>
  <A, E, R>(self: Response<A, E, R>): Response<A | B, E | E2, R | R2> =>
    make<A | B, E | E2, R | R2>(
      (info) => {
        const selected = self.select(info);
        return Option.isSome(selected) ? selected : that.select(info);
      },
      [...new Set([...self.accepts, ...that.accepts])],
    );

export const tag = <const Tag extends string, A, E, R>(
  name: Tag,
  body: Body.Decoder<A, E, R>,
): Body.Decoder<
  {
    readonly _tag: Tag;
    readonly value: A;
    readonly metadata: Metadata;
  },
  E,
  R
> =>
  Body.decoder(
    (response) => Effect.map(body.decode(response), (value) => ({ _tag: name, value, metadata: metadata(response) })),
    body.mediaType,
  );

export const decode = <A, E, R>(
  self: Response<A, E, R>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<A, UnexpectedStatus | DecodeError<E | HttpClientError.ResponseError>, R> =>
  Effect.suspend<A, UnexpectedStatus | DecodeError<E | HttpClientError.ResponseError>, R>(() => {
    const info = metadata(response);
    const selected = self.select(info);
    if (Option.isNone(selected)) {
      return Effect.zipRight(
        Effect.mapError(Body.empty.decode(response), (cause) => new DecodeError({ metadata: info, cause })),
        Effect.fail(new UnexpectedStatus({ metadata: info })),
      );
    }
    return Effect.mapError(selected.value.decode(response), (cause) => new DecodeError({ metadata: info, cause }));
  });
