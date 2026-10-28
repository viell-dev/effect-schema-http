import { Effect, Pipeable, Schema, Stream } from "effect";
import {
  HttpBody,
  HttpClientError,
  type HttpClientResponse,
  type UrlParams,
} from "effect/http";

/** A finite outgoing representation, encoded once per operation evaluation. */
export interface Encoder<in A, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly encode: (value: A) => Effect.Effect<HttpBody.HttpBody, E, R>;
}

/** A finite incoming representation. The decoder owns the selected response body. */
export interface Decoder<out A, out E = never, out R = never>
  extends Pipeable.Pipeable {
  readonly decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, E, R>;
  /** Contributes to the automatic `Accept` header of an operation. */
  readonly mediaType: string | undefined;
}

/** Both directions of one representation. Errors and services stay separate per direction. */
export interface Codec<
  A,
  EncodeError = never,
  DecodeError = never,
  EncodeServices = never,
  DecodeServices = never,
>
  extends
    Encoder<A, EncodeError, EncodeServices>,
    Decoder<A, DecodeError, DecodeServices> {}

export const encoder = <A, E = never, R = never>(
  encode: (value: A) => Effect.Effect<HttpBody.HttpBody, E, R>,
): Encoder<A, E, R> => ({
  ...Pipeable.Prototype,
  encode,
});

export const decoder = <A, E = never, R = never>(
  decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, E, R>,
  mediaType?: string,
): Decoder<A, E, R> => ({ ...Pipeable.Prototype, decode, mediaType });

export const make = <
  A,
  EncodeError = never,
  DecodeError = never,
  EncodeServices = never,
  DecodeServices = never,
>(options: {
  readonly encode: (
    value: A,
  ) => Effect.Effect<HttpBody.HttpBody, EncodeError, EncodeServices>;
  readonly decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, DecodeError, DecodeServices>;
  readonly mediaType?: string | undefined;
}): Codec<A, EncodeError, DecodeError, EncodeServices, DecodeServices> => ({
  ...Pipeable.Prototype,
  encode: options.encode,
  decode: options.decode,
  mediaType: options.mediaType,
});

const decodeFailure = (
  response: HttpClientResponse.HttpClientResponse,
  cause: unknown,
) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({
      request: response.request,
      response,
      cause,
    }),
  });

/** Any JSON value. Unlike `response.json`, an empty body is a decoding failure rather than `null`. */
export const json: Codec<
  unknown,
  HttpBody.HttpBodyError,
  HttpClientError.HttpClientError
> = make({
  encode: (value: unknown) => HttpBody.json(value),
  decode: (response) =>
    Effect.flatMap(response.text, (text) =>
      Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (cause) => decodeFailure(response, cause),
      }),
    ),
  mediaType: "application/json",
});

/** UTF-8 text. */
export const text: Codec<string, never, HttpClientError.HttpClientError> = make(
  {
    encode: (value: string) => Effect.sync(() => HttpBody.text(value)),
    decode: (response) => response.text,
    mediaType: "text/plain",
  },
);

export const bytes: Codec<Uint8Array, never, HttpClientError.HttpClientError> =
  make<Uint8Array, never, HttpClientError.HttpClientError>({
    encode: (value: Uint8Array) =>
      Effect.sync(() => HttpBody.uint8Array(value)),
    decode: (response) =>
      Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
    mediaType: "application/octet-stream",
  });

/** Multipart form data. The transport owns the boundary and its Content-Type. */
export const formData: Codec<FormData, never, HttpClientError.HttpClientError> =
  make({
    encode: (value: FormData) => Effect.sync(() => HttpBody.formData(value)),
    decode: (response) => response.formData,
    mediaType: "multipart/form-data",
  });

export const urlEncoded: Codec<
  UrlParams.UrlParams,
  never,
  HttpClientError.HttpClientError
> = make({
  encode: (value: UrlParams.UrlParams) =>
    Effect.sync(() => HttpBody.urlParams(value)),
  decode: (response) => response.urlParamsBody,
  mediaType: "application/x-www-form-urlencoded",
});

const isEmptyBody = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "EmptyBodyError";

/** No outgoing body. Incoming bytes, including unexpected ones, are drained without buffering. */
export const empty: Codec<void, never, HttpClientError.HttpClientError> = make({
  encode: () => Effect.succeed(HttpBody.empty),
  decode: (response) =>
    Stream.runDrain(response.stream).pipe(
      Effect.catchIf(isEmptyBody, () => Effect.void),
    ),
});

export const map =
  <A, B>(f: (value: A) => B) =>
  <E, R>(self: Decoder<A, E, R>): Decoder<B, E, R> =>
    decoder((response) => Effect.map(self.decode(response), f), self.mediaType);

export const mapEffect =
  <A, B, E2, R2>(f: (value: A) => Effect.Effect<B, E2, R2>) =>
  <E, R>(self: Decoder<A, E, R>): Decoder<B, E | E2, R | R2> =>
    decoder(
      (response) => Effect.flatMap(self.decode(response), f),
      self.mediaType,
    );

/** Validate a decoded value with a schema. A failure is final: it never falls through to another response case. */
export const schema = <S extends Schema.Constraint>(contract: S) => {
  const decode = Schema.decodeUnknownEffect(contract);
  return <A, E, R>(
    self: Decoder<A, E, R>,
  ): Decoder<S["Type"], E | Schema.SchemaError, R | S["DecodingServices"]> =>
    self.pipe(mapEffect((value) => decode(value)));
};

/** Validate application input with a schema and encode it with the selected wire encoder. */
export const encodeSchema = <S extends Schema.Constraint>(contract: S) => {
  const encode = Schema.encodeEffect(contract);
  return <E, R>(
    self: Encoder<S["Encoded"], E, R>,
  ): Encoder<S["Type"], E | Schema.SchemaError, R | S["EncodingServices"]> =>
    encoder((value: S["Type"]) => Effect.flatMap(encode(value), self.encode));
};

/**
 * Bidirectional JSON through the schema's canonical JSON codec (`Schema.toCodecJson`), as in Effect's own
 * JSON body helpers.
 */
export const jsonSchema = <S extends Schema.Constraint>(
  contract: S,
): Codec<
  S["Type"],
  Schema.SchemaError | HttpBody.HttpBodyError,
  Schema.SchemaError | HttpClientError.HttpClientError,
  S["EncodingServices"],
  S["DecodingServices"]
> => {
  const codec = Schema.toCodecJson(contract);
  return make({
    encode: encodeSchema(codec)(json).encode,
    decode: json.pipe(schema(codec)).decode,
    mediaType: json.mediaType,
  });
};
