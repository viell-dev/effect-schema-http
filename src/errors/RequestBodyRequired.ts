import { Data } from "effect";
import { type RequestMethod } from "../request/types.js";

/**
 * Diagnostic type for an incomplete body-bearing plan. If the type check is bypassed, evaluating its Effect fails
 * with this error before the HTTP client is called.
 */
export class RequestBodyRequired extends Data.TaggedError("RequestBodyRequired")<{
  /** Configured HTTP method. */
  readonly method: RequestMethod;
  /** Configured endpoint path. */
  readonly path: string;
  /** Stable guidance for making the plan executable. */
  readonly reason: "Call setBody before reading effect";
}> {}
