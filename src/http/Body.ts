import { HttpBody, HttpClientError, HttpClientResponse, UrlParams } from "@effect/platform";
import { Effect, ParseResult, Pipeable, Schema, Stream } from "effect";

/** A finite outgoing representation, encoded once per operation evaluation. */
export interface Encoder<in A, out E = never, out R = never> {
  readonly encode: (value: A) => Effect.Effect<HttpBody.HttpBody, E, R>;
}

/** A finite incoming representation. The decoder owns the selected body. */
export interface Decoder<out A, out E = never, out R = never> extends Pipeable.Pipeable {
  readonly decode: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>;
  readonly mediaType?: string;
}

export interface Codec<A, EncodeError = never, DecodeError = never, EncodeContext = never, DecodeContext = never>
  extends Encoder<A, EncodeError, EncodeContext>, Decoder<A, DecodeError, DecodeContext> {}

export const decoder = <A, E, R>(decode: Decoder<A, E, R>["decode"], mediaType?: string): Decoder<A, E, R> => ({
  decode,
  mediaType,
  pipe() {
    // eslint-disable-next-line prefer-rest-params -- Effect pipeArguments accepts IArguments.
    return Pipeable.pipeArguments(this, arguments);
  },
});

export const encoder = <A, E, R>(encode: Encoder<A, E, R>["encode"]): Encoder<A, E, R> => ({ encode });

export const make = <A, EE, DE, ER, DR>(
  options: Encoder<A, EE, ER> & Omit<Decoder<A, DE, DR>, "pipe">,
): Codec<A, EE, DE, ER, DR> => ({
  ...decoder(options.decode, options.mediaType),
  encode: options.encode,
});

export const json: Codec<unknown, HttpBody.HttpBodyError, HttpClientError.ResponseError> = make({
  encode: HttpBody.json,
  decode: (response) =>
    Effect.flatMap(response.text, (value) =>
      Effect.try({
        // Platform treats empty JSON as null. JSON syntax distinguishes those representations.
        try: () => JSON.parse(value) as unknown,
        catch: (cause) =>
          new HttpClientError.ResponseError({ request: response.request, response, reason: "Decode", cause }),
      }),
    ),
  mediaType: "application/json",
});

export const text: Codec<string, never, HttpClientError.ResponseError> = make({
  encode: (value) => Effect.sync(() => HttpBody.text(value)),
  decode: (response) => response.text,
  mediaType: "text/plain",
});

export const bytes: Codec<Uint8Array, never, HttpClientError.ResponseError> = make({
  encode: (value) => Effect.sync(() => HttpBody.uint8Array(value)),
  decode: (response) => Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
  mediaType: "application/octet-stream",
});

export const formData: Codec<FormData, never, HttpClientError.ResponseError> = make({
  encode: (value) => Effect.sync(() => HttpBody.formData(value)),
  decode: (response) => response.formData,
  mediaType: "multipart/form-data",
});

export const urlEncoded: Codec<UrlParams.UrlParams, never, HttpClientError.ResponseError> = make({
  encode: (value) => Effect.sync(() => HttpBody.urlParams(value)),
  decode: (response) => response.urlParamsBody,
  mediaType: "application/x-www-form-urlencoded",
});

/** Drain without buffering, including erroneous payloads on bodyless responses. */
export const empty: Codec<void, never, HttpClientError.ResponseError> = make({
  encode: () => Effect.succeed(HttpBody.empty),
  decode: (response) =>
    Stream.runDrain(response.stream).pipe(
      Effect.catchIf(
        (error) => error.reason === "EmptyBody",
        () => Effect.void,
      ),
    ),
});

export const map =
  <A, B>(f: (value: A) => B) =>
  <E, R>(self: Decoder<A, E, R>): Decoder<B, E, R> =>
    decoder((response) => Effect.map(self.decode(response), f), self.mediaType);

export const mapEffect =
  <A, B, E2, R2>(f: (value: A) => Effect.Effect<B, E2, R2>) =>
  <E, R>(self: Decoder<A, E, R>): Decoder<B, E | E2, R | R2> =>
    decoder((response) => Effect.flatMap(self.decode(response), f), self.mediaType);

/** Schema decoding is binding; failure never falls through to another response case. */
export const schema =
  <A, I, R2>(contract: Schema.Schema<A, I, R2>) =>
  <I2, E, R>(self: Decoder<I2, E, R>): Decoder<A, E | ParseResult.ParseError, R | R2> =>
    self.pipe(mapEffect(Schema.decodeUnknown(contract)));

/** Validate application input and encode into the selected wire representation. */
export const encodeSchema =
  <A, I, R2>(contract: Schema.Schema<A, I, R2>) =>
  <E, R>(self: Encoder<I, E, R>): Encoder<A, E | ParseResult.ParseError, R | R2> =>
    encoder((value) => Effect.flatMap(Schema.encode(contract)(value), self.encode));

export const jsonSchema = <A, I, R>(
  contract: Schema.Schema<A, I, R>,
): Codec<
  A,
  HttpBody.HttpBodyError | ParseResult.ParseError,
  HttpClientError.ResponseError | ParseResult.ParseError,
  R,
  R
> =>
  make({
    encode: encodeSchema(contract)(json).encode,
    decode: json.pipe(schema(contract)).decode,
    mediaType: json.mediaType,
  });
