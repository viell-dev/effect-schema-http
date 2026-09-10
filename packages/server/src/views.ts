import { Effect } from "effect";
import { NonNegativeInt, type NotFoundError, type Post, type PostView } from "@realworld/domain";
import { Store } from "./store.js";

export const postToView = (post: Post): Effect.Effect<PostView, NotFoundError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const [author, commentCount] = yield* Effect.all([
      store.getAccount(post.authorId),
      store.commentCountByPost(post.id),
    ]);
    return {
      id: post.id,
      authorId: post.authorId,
      authorUsername: author.username,
      slug: post.slug,
      title: post.title,
      body: post.body,
      visibility: post.visibility,
      commentCount: NonNegativeInt.make(commentCount),
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    };
  });
