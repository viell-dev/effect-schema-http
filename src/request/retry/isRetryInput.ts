import { HttpClientError } from "@effect/platform";
import { Cause } from "effect";
import { isHttpClientResponse } from "../isHttpClientResponse.js";
import { type RetryInput } from "../types.js";

export const isRetryInput = (input: unknown): input is RetryInput =>
  isHttpClientResponse(input) || Cause.isTimeoutException(input) || HttpClientError.isHttpClientError(input);
