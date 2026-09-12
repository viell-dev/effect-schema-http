import { HttpClientError, HttpClientResponse } from "@effect/platform";

/** Constructs a provider-compatible response body error. */
export const responseBodyError = (
  response: HttpClientResponse.HttpClientResponse,
  reason: "Decode" | "EmptyBody",
  cause?: unknown,
) =>
  new HttpClientError.ResponseError({
    request: response.request,
    response,
    reason,
    cause,
  });
