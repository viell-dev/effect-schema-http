import { HttpClientResponse } from "@effect/platform";
import { Data, ParseResult } from "effect";

/**
 * Wraps schema parsing failures with the selected rule and raw HTTP response.
 *
 * @public
 */
export class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  /** `_tag` of the response rule whose schema failed. */
  readonly responseTag: string;
  /** Original HTTP response. */
  readonly response: HttpClientResponse.HttpClientResponse;
  /** Effect Schema parsing failure. */
  readonly cause: ParseResult.ParseError;
}> {
  /** HTTP status of the response that failed schema decoding. */
  get status(): number {
    return this.response.status;
  }
}
