import { Data, Effect, Option, Pipeable } from "effect";
import type {
  Cookies,
  Headers,
  HttpClientError,
  HttpClientResponse,
} from "effect/http";
import * as Body from "./Body.js";
import * as Transport from "./Transport.js";

/** Transport metadata only. Response cases select a decoder from it; it has no access to the body. */
export interface Metadata {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly cookies: Cookies.Cookies;
  /** Provider-observed lines, when the provider supplied them. Normalized headers are always available. */
  readonly headerLines: Option.Option<Transport.Lines>;
}

/** No response case matched. The body was drained; only metadata is retained. */
export class UnexpectedResponse extends Data.TaggedError("UnexpectedResponse")<{
  readonly metadata: Metadata;
}> {}

/** The selected decoder failed, or draining an unmatched body failed. `cause` keeps the decoder's typed error. */
export class DecodeError<out E> extends Data.TaggedError("DecodeError")<{
  readonly metadata: Metadata;
  readonly cause: E;
}> {}

/** Selects a decoder for a response, or none. Cases are ordered by explicit composition. */
export interface Response<out A, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly select: (metadata: Metadata) => Option.Option<Body.Decoder<A, E, R>>;
  /** Media types contributed to the automatic `Accept` header, in declaration order. */
  readonly accepts: ReadonlyArray<string>;
}

export const metadata = (
  response: HttpClientResponse.HttpClientResponse,
): Metadata => ({
  status: response.status,
  headers: response.headers,
  cookies: response.cookies,
  headerLines: Transport.responseHeaderLines(response),
});

const make = <A, E, R>(
  select: Response<A, E, R>["select"],
  accepts: ReadonlyArray<string>,
): Response<A, E, R> => ({
  ...Pipeable.Prototype,
  select,
  accepts,
});

export const when = <A, E, R>(
  predicate: (metadata: Metadata) => boolean,
  body: Body.Decoder<A, E, R>,
): Response<A, E, R> =>
  make(
    (info) => (predicate(info) ? Option.some(body) : Option.none()),
    body.mediaType === undefined ? [] : [body.mediaType],
  );

export const status = <A, E, R>(
  code: number,
  body: Body.Decoder<A, E, R>,
): Response<A, E, R> => when((info) => info.status === code, body);

/** Declaration order is priority: the fallback is consulted only when this response has no matching case. */
export const orElse =
  <B, E2, R2>(that: Response<B, E2, R2>) =>
  <A, E, R>(self: Response<A, E, R>): Response<A | B, E | E2, R | R2> =>
    make<A | B, E | E2, R | R2>(
      (info) => Option.orElse(self.select(info), () => that.select(info)),
      Array.from(new Set([...self.accepts, ...that.accepts])),
    );

/** An optional envelope that records which case matched, with the decoded value and its metadata. */
export interface Tagged<Tag extends string, A> {
  readonly _tag: Tag;
  readonly value: A;
  readonly metadata: Metadata;
}

export const tag = <const Tag extends string, A, E, R>(
  name: Tag,
  body: Body.Decoder<A, E, R>,
): Body.Decoder<Tagged<Tag, A>, E, R> =>
  Body.decoder(
    (response) =>
      Effect.map(body.decode(response), (value) => ({
        _tag: name,
        value,
        metadata: metadata(response),
      })),
    body.mediaType,
  );

/** Select a case from metadata alone, then decode its body. An unmatched body is drained before failing. */
export const decode = <A, E, R>(
  self: Response<A, E, R>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  A,
  UnexpectedResponse | DecodeError<E | HttpClientError.HttpClientError>,
  R
> =>
  Effect.suspend(() => {
    const info = metadata(response);
    const selected = self.select(info);
    const decodeError = (cause: E | HttpClientError.HttpClientError) =>
      new DecodeError({ metadata: info, cause });
    if (Option.isNone(selected)) {
      return Body.empty
        .decode(response)
        .pipe(
          Effect.mapError(decodeError),
          Effect.andThen(
            Effect.fail(new UnexpectedResponse({ metadata: info })),
          ),
        );
    }
    return Effect.mapError(selected.value.decode(response), decodeError);
  });
