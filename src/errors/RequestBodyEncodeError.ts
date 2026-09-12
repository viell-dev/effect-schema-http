import { HttpBody, HttpClientRequest } from "@effect/platform";
import { Data, ParseResult } from "effect";

/** Wraps schema encoding or transport body construction failures with the request. */
export class RequestBodyEncodeError extends Data.TaggedError("RequestBodyEncodeError")<{
  /** Request being constructed when encoding failed. */
  readonly request: HttpClientRequest.HttpClientRequest;
  /** Schema encoding or HTTP body construction failure. */
  readonly cause: ParseResult.ParseError | HttpBody.HttpBodyError;
}> {}
