/**
 * Comments, which may come from a registered user or an anonymous visitor.
 *
 * `CommentAuthor` is a `_tag`-discriminated `Schema.Union`, the same pattern the `repo` library's
 * own README uses for its response unions and that composes with `Match.tag`/`Match.exhaustive`
 * on the way out to the UI.
 */
import { Schema } from "effect";
import { CommentId, PostId, UserId } from "./ids.js";
import { DisplayName, Username } from "./primitives.js";

export const RegisteredCommentAuthor = Schema.Struct({
  _tag: Schema.Literal("registered"),
  userId: UserId,
  username: Username,
});
export type RegisteredCommentAuthor = typeof RegisteredCommentAuthor.Type;

export const AnonymousCommentAuthor = Schema.Struct({
  _tag: Schema.Literal("anonymous"),
  displayName: DisplayName,
});
export type AnonymousCommentAuthor = typeof AnonymousCommentAuthor.Type;

export const CommentAuthor = Schema.Union(RegisteredCommentAuthor, AnonymousCommentAuthor);
export type CommentAuthor = typeof CommentAuthor.Type;

export const CommentBody = Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(2_000), Schema.brand("CommentBody"));
export type CommentBody = typeof CommentBody.Type;

export class Comment extends Schema.Class<Comment>("Comment")({
  id: CommentId,
  postId: PostId,
  author: CommentAuthor,
  body: CommentBody,
  createdAt: Schema.DateTimeUtc,
}) {}

export const CommentView = Schema.Struct({
  id: CommentId,
  postId: PostId,
  author: CommentAuthor,
  body: CommentBody,
  createdAt: Schema.DateTimeUtc,
});
export type CommentView = typeof CommentView.Type;
