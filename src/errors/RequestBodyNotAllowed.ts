import { HttpClientRequest } from "@effect/platform";
import { Data } from "effect";

/** Indicates that the library rejected a non-empty `GET` or `HEAD` body after request transforms. */
export class RequestBodyNotAllowed extends Data.TaggedError("RequestBodyNotAllowed")<{
  /** Request rejected because its method does not permit the configured body. */
  readonly request: HttpClientRequest.HttpClientRequest;
}> {}
