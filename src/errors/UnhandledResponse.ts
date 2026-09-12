import { Headers, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Data, Effect } from "effect";
import { discardResponseBody } from "../body/discardResponseBody.js";

/**
 * Indicates that no response rule matched.
 *
 * @remarks
 * The error retains the Effect Platform response. With the default `"discard"` policy its body has already been
 * drained. Use `unhandledResponseBody: "retain"` when the caller must inspect or consume that body, and then run
 * {@link UnhandledResponse.discard} if it is otherwise unused.
 *
 * @public
 */
export class UnhandledResponse extends Data.TaggedError("UnhandledResponse")<{
  /** Original unmatched response. */
  readonly response: HttpClientResponse.HttpClientResponse;
}> {
  /** HTTP status of the unmatched response. */
  get status(): number {
    return this.response.status;
  }

  /** Normalized headers of the unmatched response. */
  get headers(): Headers.Headers {
    return this.response.headers;
  }

  /** Drains the retained response body so the provider can release its resources. */
  get discard(): Effect.Effect<void, HttpClientError.ResponseError> {
    return discardResponseBody(this.response);
  }
}
