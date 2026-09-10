/**
 * Admin-only endpoints. `/api/admin/stats` is the oldest surviving endpoint in this backend: it
 * was wired up before the JSON API existed, dumping a byte buffer with `Content-Type:
 * application/octet-stream` because that's what its original (long-gone) internal caller expected.
 * Nobody has touched it since, including its content-type — so this schema treats the bytes as
 * UTF-8 JSON via `Schema.transformOrFail`, the same "text/bytes hiding a real payload" pattern the
 * `Atom` feed uses for XML, just one layer further down (bytes, not even declared as text).
 */
import { ParseResult, Schema } from "effect";
import { NonNegativeInt } from "./primitives.js";

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

/** No request or response payload at all — a bare RPC-style admin command. Paired client-side
 * with `ResponseBody.none`, per the library's README: "Use `ResponseBody.none` explicitly for
 * `HEAD`, `204`, or other bodyless responses." */
export const CacheRefreshed = Schema.Void;
