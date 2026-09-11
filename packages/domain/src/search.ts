/**
 * Search, which is not really part of this API at all.
 *
 * It is a vendor product that was bought, pointed at the post table, and exposed through
 * `GET /api/search` by a proxy rule that passes its responses through untouched. Nobody ever
 * normalised it, so it is the one corner of this API that follows none of the conventions the
 * rest of it follows:
 *
 * - **Pagination lives in response headers** (`X-Total-Count`, `X-Page`, `X-Per-Page`) and the
 *   body is a bare JSON array, not an envelope with a `posts` field like every other list here.
 * - **`tags` is a string when there is one and an array when there are several.** This is the
 *   single most common shape bug in the wild and it is load-bearing for the vendor's own UI, so
 *   it will never be fixed.
 * - **`score` is a numeric string** and **`is_public` is `"1"` or `"0"`**, because the vendor's
 *   serializer stringifies everything.
 * - **No results means a `200` with an empty body**, not `[]`. That is the one that actually
 *   breaks clients: a JSON parser handed zero bytes fails, and this one is no exception — the
 *   `repo` library's JSON codec rejects empty payloads by design, so the empty case has to be
 *   selected as a *different response rule* on `content-length: 0` and read with
 *   `ResponseBody.none`. See `packages/web/src/api.ts`.
 *
 * Everything below converts that into ordinary domain values at the edge. The rest of the
 * application never learns that search is different.
 */
import { ParseResult, Schema } from "effect";
import { PostTitle } from "./post.js";
import { NonNegativeInt, Slug } from "./primitives.js";

/** A tag list that arrives as either one string or several. Normalised to an array on the way in. */
export const SearchTags = Schema.transform(
  Schema.Union(Schema.String, Schema.Array(Schema.String)),
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (value) => (typeof value === "string" ? [value] : value),
    // Encoding reproduces the vendor's own inconsistency rather than hiding it, so a round trip
    // through this schema is faithful to what the vendor would have sent.
    encode: (tags) => (tags.length === 1 ? (tags[0] ?? "") : tags),
  },
);
export type SearchTags = typeof SearchTags.Type;

/** `"1"` / `"0"`, because the vendor's serializer has no concept of a boolean. */
export const BooleanFromZeroOne = Schema.transform(Schema.Literal("0", "1"), Schema.Boolean, {
  strict: true,
  decode: (value) => value === "1",
  encode: (value) => (value ? ("1" as const) : ("0" as const)),
});
export type BooleanFromZeroOne = typeof BooleanFromZeroOne.Type;

export const SearchHit = Schema.Struct({
  slug: Slug,
  title: PostTitle,
  tags: SearchTags,
  score: Schema.NumberFromString,
  is_public: BooleanFromZeroOne,
});
export type SearchHit = typeof SearchHit.Type;

/** The body: a bare array. Everything else about the result set is in the response headers. */
export const SearchHits = Schema.Array(SearchHit);
export type SearchHits = typeof SearchHits.Type;

/** Header-carried pagination, parsed by the caller from the response's own fields. */
export const SearchPagination = Schema.Struct({
  total: NonNegativeInt,
  page: NonNegativeInt,
  perPage: NonNegativeInt,
});
export type SearchPagination = typeof SearchPagination.Type;

/**
 * Reads the vendor's pagination fields off a response. Missing fields are a real possibility —
 * the proxy drops them on some error paths — so this fails loudly rather than guessing.
 */
export const paginationFromHeaders = Schema.transformOrFail(
  Schema.Struct({
    "x-total-count": Schema.String,
    "x-page": Schema.String,
    "x-per-page": Schema.String,
  }),
  SearchPagination,
  {
    strict: true,
    decode: (headers, _options, ast) => {
      const total = Number(headers["x-total-count"]);
      const page = Number(headers["x-page"]);
      const perPage = Number(headers["x-per-page"]);
      return [total, page, perPage].every((value) => Number.isInteger(value) && value >= 0)
        ? ParseResult.succeed({ total, page, perPage })
        : ParseResult.fail(new ParseResult.Type(ast, headers, "vendor pagination fields were not whole numbers"));
    },
    encode: (pagination) =>
      ParseResult.succeed({
        "x-total-count": String(pagination.total),
        "x-page": String(pagination.page),
        "x-per-page": String(pagination.perPage),
      }),
  },
);
