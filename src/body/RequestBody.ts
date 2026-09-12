import { HttpClientRequest, UrlParams } from "@effect/platform";
import { Effect } from "effect";
import { type RequestBodyCodec } from "../request/types.js";
import { jsonRequestBodyCodec } from "./jsonRequestBodyCodec.js";

/** Built-in request-body codecs. */
export const RequestBody = {
  /** Serializes an arbitrary JSON-compatible value. */
  json: jsonRequestBodyCodec,
  /** Serializes a string, optionally with an explicit content type. */
  text: (contentType?: string) =>
    ({
      name: "text" as const,
      encode: (input: string, request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientRequest.bodyText(request, input, contentType)),
    }) satisfies RequestBodyCodec<string>,
  /** Serializes bytes, optionally with an explicit content type. */
  uint8Array: (contentType?: string) =>
    ({
      name: "uint8-array" as const,
      encode: (input: Uint8Array, request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientRequest.bodyUint8Array(request, input, contentType)),
    }) satisfies RequestBodyCodec<Uint8Array>,
  /** Serializes URL-encoded form parameters. */
  urlParams: {
    name: "url-params" as const,
    encode: (input: UrlParams.Input, request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientRequest.bodyUrlParams(request, input)),
  } satisfies RequestBodyCodec<UrlParams.Input>,
  /** Serializes browser-compatible multipart form data. */
  formData: {
    name: "form-data" as const,
    encode: (input: FormData, request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientRequest.bodyFormData(request, input)),
  } satisfies RequestBodyCodec<FormData>,
} as const;
