/**
 * Admin-only endpoints. `/api/admin/stats` is the oldest surviving endpoint in this backend: it
 * was wired up before the JSON API existed, dumping a byte buffer with `Content-Type:
 * application/octet-stream` because that's what its original (long-gone) internal caller expected.
 * Nobody has touched it since, including its content-type — so this schema treats the bytes as
 * UTF-8 JSON via `Schema.transformOrFail`, the same "text/bytes hiding a real payload" pattern the
 * `Atom` feed uses for XML, just one layer further down (bytes, not even declared as text).
 */
import { ParseResult, Schema } from "effect";
import { Filename, MimeType, NonNegativeInt } from "./primitives.js";

export const AdminStats = Schema.Struct({
  users: NonNegativeInt,
  posts: NonNegativeInt,
  comments: NonNegativeInt,
  generatedAt: Schema.DateTimeUtc,
});
export type AdminStats = typeof AdminStats.Type;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const AdminStatsFromBytes = Schema.transformOrFail(Schema.Uint8ArrayFromSelf, AdminStats, {
  decode: (bytes, _options, ast) => {
    try {
      return ParseResult.succeed(JSON.parse(decoder.decode(bytes)) as Schema.Schema.Encoded<typeof AdminStats>);
    } catch {
      return ParseResult.fail(new ParseResult.Type(ast, bytes, "legacy stats payload was not valid UTF-8 JSON"));
    }
  },
  encode: (stats) => ParseResult.succeed(encoder.encode(JSON.stringify(stats))),
});
export type AdminStatsFromBytes = typeof AdminStatsFromBytes.Type;

/** An optional note logged alongside a cache refresh. The response carries no payload at all —
 * paired client-side with `ResponseBody.none`, per the library's README: "Use `ResponseBody.none`
 * explicitly for `HEAD`, `204`, or other bodyless responses." This one deliberately answers with
 * `205 Reset Content` rather than `204 No Content`: per HTTP semantics, `205` tells the client the
 * *view that submitted the request* should be reset, which is exactly what the admin page's
 * "reason" field should do on success — see `packages/web/src/pages/admin.ts`. */
export const RefreshCacheInput = Schema.Struct({
  reason: Schema.optional(Schema.String.pipe(Schema.maxLength(280))),
});
export type RefreshCacheInput = typeof RefreshCacheInput.Type;

export const CacheRefreshed = Schema.Void;

/**
 * Search reindexing: the one endpoint here that is genuinely flaky by design. The search cluster
 * is warm-standby, so the first calls after a cold start answer `503` with a `Retry-After` header
 * until it is ready. That makes it the natural place to exercise the `repo` library's retry
 * policy, whose transient classification already covers `503`, and whose `respectRetryAfter`
 * treats that header as a minimum delay over the configured schedule.
 */
export const ReindexAccepted = Schema.Struct({
  indexed: NonNegativeInt,
  attempts: NonNegativeInt,
});
export type ReindexAccepted = typeof ReindexAccepted.Type;

/**
 * A bundle of one attachment's metadata and bytes in a single multipart response — the shape a
 * long-dead internal tool asked for, and the only endpoint here whose *response* is form data.
 * The client decodes it with `ResponseBody.formData` and `Schema.instanceOf(FormData)`, then pulls
 * the `metadata` part through this schema; the bytes ride along in the `file` part without ever
 * being base64'd into JSON.
 */
export const BundleMetadata = Schema.Struct({
  filename: Filename,
  contentType: MimeType,
  size: NonNegativeInt,
});
export type BundleMetadata = typeof BundleMetadata.Type;
