/**
 * Blog post domain entities.
 *
 * `PostVisibility` is a plain literal union (a `_tag`-free discriminated value, unlike the
 * `_tag`-carrying unions used for API responses/errors). `Post` is the server-side record.
 * `PostView` is the wire shape returned to clients, with a custom `equivalence` annotation: two
 * views are "the same post" for test/log purposes when their identity and content match,
 * ignoring the `updatedAt` bookkeeping timestamp and the `revision` counter. That is a deliberate override of the default
 * derived (fully structural) equivalence every `Schema.Struct` gets for free.
 */
import { Schema } from "effect";
import { PostId, UserId } from "./ids.js";
import { NonNegativeInt, Slug, Username } from "./primitives.js";

export const PostVisibility = Schema.Literal("public", "draft", "private");
export type PostVisibility = typeof PostVisibility.Type;

export const PostTitle = Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(160), Schema.brand("PostTitle"));
export type PostTitle = typeof PostTitle.Type;

export const PostBody = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000), Schema.brand("PostBody"));
export type PostBody = typeof PostBody.Type;

/**
 * A post's optimistic-concurrency token: bumped on every write, so a client can say which version
 * it was looking at. This started out as `updatedAt`, which was wrong — two writes landing in the
 * same millisecond produce the same timestamp, and a stale editor sails straight through the
 * check. A counter cannot collide.
 */
export const PostRevision = NonNegativeInt.pipe(Schema.brand("PostRevision"));
export type PostRevision = typeof PostRevision.Type;

export class Post extends Schema.Class<Post>("Post")({
  id: PostId,
  authorId: UserId,
  slug: Slug,
  title: PostTitle,
  body: PostBody,
  visibility: PostVisibility,
  revision: PostRevision,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}) {}

export const PostView = Schema.Struct({
  id: PostId,
  authorId: UserId,
  authorUsername: Username,
  slug: Slug,
  title: PostTitle,
  body: PostBody,
  visibility: PostVisibility,
  revision: PostRevision,
  commentCount: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}).annotations({
  identifier: "PostView",
  equivalence: () => (a, b) =>
    a.id === b.id &&
    a.authorId === b.authorId &&
    a.slug === b.slug &&
    a.title === b.title &&
    a.body === b.body &&
    a.visibility === b.visibility &&
    a.commentCount === b.commentCount,
});
export type PostView = typeof PostView.Type;
