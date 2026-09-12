import type { Headers } from "@effect/platform";
import { Data, type ParseResult, Schema } from "effect";

export const CatalogItem = Schema.Struct({ id: Schema.UUID, name: Schema.NonEmptyString });
export const NewCatalogItem = Schema.Struct({ name: Schema.NonEmptyString });
export const CreatedCatalogItem = Schema.Struct({ id: Schema.UUID });
export const CatalogQuery = Schema.Struct({
  offset: Schema.NumberFromString.pipe(Schema.int(), Schema.nonNegative()),
  limit: Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
});

/** This example service defines a required decimal count header; it is not a library-wide convention. */
export const PageHeaders = Schema.Struct({
  "x-total-count": Schema.String.pipe(
    Schema.pattern(/^(0|[1-9]\d*)$/u),
    Schema.compose(Schema.NumberFromString),
    Schema.int(),
    Schema.nonNegative(),
    Schema.filter(Number.isSafeInteger, { message: () => "Expected a safe integer count" }),
  ),
});

export class InvalidPageMetadata extends Data.TaggedError("InvalidPageMetadata")<{
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly cause: ParseResult.ParseError;
}> {}
