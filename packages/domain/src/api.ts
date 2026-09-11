/**
 * Request/response payload schemas for every endpoint. Kept separate from the entity schemas in
 * `user.ts`/`post.ts`/`comment.ts` because wire shapes and storage shapes legitimately diverge
 * (e.g. registration takes a plaintext `Password`; nothing about `Account` should).
 */
import { Schema } from "effect";
import { PostBody, PostCategory, PostTitle, PostView, PostVisibility } from "./post.js";
import { Bio, DisplayName, Email, NonZeroPositiveInt, Password, Username } from "./primitives.js";
import { CommentBody, CommentView } from "./comment.js";
import { Profile } from "./user.js";
import { AttachmentView } from "./attachment.js";

export const RegisterInput = Schema.Struct({
  username: Username,
  email: Email,
  password: Password,
  displayName: DisplayName,
  bio: Schema.optional(Bio),
});
export type RegisterInput = typeof RegisterInput.Type;

export const CreatePostInput = Schema.Struct({
  title: PostTitle,
  body: PostBody,
  visibility: PostVisibility,
  /**
   * Added with categories, and optional *with a default* rather than required — which is
   * what makes the change safe in both directions at once. A client compiled before
   * categories existed sends no field and the server fills one in; a client compiled
   * after sends one and the server uses it. Neither end has to know which version the
   * other is running.
   */
  category: Schema.optionalWith(PostCategory, { default: (): PostCategory => "uncategorised" }),
});
export type CreatePostInput = typeof CreatePostInput.Type;

export const UpdatePostInput = Schema.Struct({
  title: Schema.optional(PostTitle),
  body: Schema.optional(PostBody),
  visibility: Schema.optional(PostVisibility),
  category: Schema.optional(PostCategory),
});
export type UpdatePostInput = typeof UpdatePostInput.Type;

/**
 * Anonymous comments must supply a `displayName`; comments from an authenticated session ignore
 * it and use the session's own username instead. That cross-field rule lives in the handler, not
 * the schema, because it depends on the request's auth state rather than the payload alone.
 */
export const CreateCommentInput = Schema.Struct({
  body: CommentBody,
  displayName: Schema.optional(DisplayName),
});
export type CreateCommentInput = typeof CreateCommentInput.Type;

export const PageQuery = Schema.Struct({
  page: Schema.optionalWith(NonZeroPositiveInt, { default: () => 1 as NonZeroPositiveInt }),
  limit: Schema.optionalWith(NonZeroPositiveInt, { default: () => 20 as NonZeroPositiveInt }),
});
export type PageQuery = typeof PageQuery.Type;

export const BlogResponse = Schema.Struct({
  profile: Profile,
  posts: Schema.Array(PostView),
});
export type BlogResponse = typeof BlogResponse.Type;

export const FeedResponse = Schema.Struct({
  posts: Schema.Array(PostView),
  page: NonZeroPositiveInt,
  limit: NonZeroPositiveInt,
});
export type FeedResponse = typeof FeedResponse.Type;

export const CommentsResponse = Schema.Struct({
  comments: Schema.Array(CommentView),
});
export type CommentsResponse = typeof CommentsResponse.Type;

export const AttachmentsResponse = Schema.Struct({
  attachments: Schema.Array(AttachmentView),
});
export type AttachmentsResponse = typeof AttachmentsResponse.Type;
