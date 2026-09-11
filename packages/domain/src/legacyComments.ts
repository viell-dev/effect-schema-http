/**
 * `POST /api/v1/comments`, the original comment endpoint, kept alive because an old mobile client
 * still posts to it and would break on anything it does not already parse.
 *
 * It is wrong in four ways that were normal where it came from, and every one of them is a thing
 * real APIs do:
 *
 * 1. **Every response is `200`**, success or failure. HTTP was treated as a dumb transport and the
 *    real outcome lives in a `status` field in the body. A `404` would have been a transport-level
 *    fault to that client, not a business outcome.
 * 2. **`snake_case` fields**, because the service it was copied from was written in a language
 *    where that is the convention, and nobody normalised it when the JSON API grew up around it.
 * 3. **Timestamps as epoch seconds**, not ISO 8601 — and seconds, not milliseconds, so the obvious
 *    `new Date(value)` reading is wrong by a factor of a thousand.
 * 4. **The post is identified in the body**, not the path, so the URL says nothing about what is
 *    being commented on.
 *
 * None of this is defensible, and none of it is going to change. What matters here is that all
 * four are absorbed by schemas at the edge: everything inside this application still deals in
 * `CommentId`, `CommentBody`, and `DateTime.Utc`, and the ugliness stops at this file.
 */
import { ParseResult, Schema } from "effect";
import { CommentId } from "./ids.js";
import { CommentBody } from "./comment.js";
import { DisplayName, Slug } from "./primitives.js";

/**
 * Epoch **seconds** to a real `DateTime.Utc`. Effect ships `Schema.DateTimeUtcFromNumber` for
 * epoch millis, so this is that schema with a factor of a thousand in front of it, which is the
 * whole fix — expressed once, here, rather than as a `* 1000` scattered across call sites.
 */
export const DateTimeUtcFromEpochSeconds = Schema.transformOrFail(Schema.Number, Schema.DateTimeUtcFromNumber, {
  strict: true,
  decode: (seconds, _options, ast) =>
    Number.isFinite(seconds)
      ? ParseResult.succeed(Math.round(seconds * 1000))
      : ParseResult.fail(new ParseResult.Type(ast, seconds, "not a finite epoch-seconds value")),
  encode: (millis) => ParseResult.succeed(Math.round(millis / 1000)),
});
export type DateTimeUtcFromEpochSeconds = typeof DateTimeUtcFromEpochSeconds.Type;

export const LegacyCommentRequest = Schema.Struct({
  post_slug: Slug,
  comment_body: CommentBody,
  display_name: Schema.optional(DisplayName),
});
export type LegacyCommentRequest = typeof LegacyCommentRequest.Type;

export const LegacyCommentOk = Schema.Struct({
  status: Schema.Literal("ok"),
  comment_id: CommentId,
  created_at: DateTimeUtcFromEpochSeconds,
});
export type LegacyCommentOk = typeof LegacyCommentOk.Type;

export const LegacyCommentFailure = Schema.Struct({
  status: Schema.Literal("error"),
  error_code: Schema.Literal("invalid", "not_found", "forbidden"),
  error_message: Schema.String,
});
export type LegacyCommentFailure = typeof LegacyCommentFailure.Type;

/**
 * The endpoint's whole response surface, at one status. Because the outcome is in the body rather
 * than the status line, the `repo` library's response rules cannot select between these two — rule
 * selection happens before decoding, on status and headers only. So they are modelled as a
 * `Schema.Union` inside a single `200` rule, and the caller discriminates on `status` afterwards.
 * `Schema.Union` over literal-discriminated members gives the same exhaustiveness guarantees one
 * level down; what is lost is the ability to put the two outcomes in different response rules.
 */
export const LegacyCommentResponse = Schema.Union(LegacyCommentOk, LegacyCommentFailure);
export type LegacyCommentResponse = typeof LegacyCommentResponse.Type;
