import { Effect } from "effect";
import {
  NonNegativeInt,
  type NotFoundError,
  type Post,
  type PostView,
  type PostViewV2,
} from "@realworld/domain";
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
      revision: post.revision,
      commentCount: NonNegativeInt.make(commentCount),
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    };
  });

/**
 * The same view with the category the older one does not carry.
 *
 * Written as "v1 plus the new field" rather than as a second projection, so the two
 * cannot drift: the only difference between the versions is the line below.
 */
export const postToViewV2 = (post: Post): Effect.Effect<PostViewV2, NotFoundError, Store> =>
  Effect.map(postToView(post), (view) => ({ ...view, category: post.category }));
