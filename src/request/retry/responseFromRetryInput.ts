import { HttpClientError, HttpClientResponse } from "@effect/platform";
import { isHttpClientResponse } from "../isHttpClientResponse.js";
import { type RetryInput } from "../types.js";

export const responseFromRetryInput = (input: RetryInput): HttpClientResponse.HttpClientResponse | undefined =>
  isHttpClientResponse(input)
    ? input
    : HttpClientError.isHttpClientError(input) && input._tag === "ResponseError"
      ? input.response
      : undefined;
