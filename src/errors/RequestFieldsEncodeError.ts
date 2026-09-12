import { Data, type ParseResult } from "effect";

/** A selected header or query schema rejected the application-side field collection. */
export class RequestFieldsEncodeError extends Data.TaggedError("RequestFieldsEncodeError")<{
  readonly field: "headers" | "urlParams";
  readonly cause: ParseResult.ParseError;
}> {}
