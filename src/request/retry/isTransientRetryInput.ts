import { HttpClientError } from "@effect/platform";
import { Cause } from "effect";
import { isHttpClientResponse } from "../isHttpClientResponse.js";
import { type RetryInput } from "../types.js";
import { isTransientResponseStatus } from "./isTransientResponseStatus.js";

export const isTransientRetryInput = (input: RetryInput): boolean =>
  isHttpClientResponse(input)
    ? isTransientResponseStatus(input.status)
    : Cause.isTimeoutException(input) ||
      (HttpClientError.isHttpClientError(input) &&
        ((input._tag === "RequestError" && input.reason === "Transport") ||
          (input._tag === "ResponseError" && isTransientResponseStatus(input.response.status))));
