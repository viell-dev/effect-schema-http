import { HttpClientRequest } from "@effect/platform";
import { type RequestBodyCodec } from "../request/types.js";

/** Default JSON request-body codec. */
export const jsonRequestBodyCodec = {
  name: "json" as const,
  encode: (input: unknown, request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.bodyJson(request, input),
} satisfies RequestBodyCodec<unknown>;
