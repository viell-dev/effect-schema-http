/**
 * Route handlers. Each one is an `Effect` that always succeeds with a `JsonResponse` — domain
 * errors are caught here and turned into their encoded body + status, so the transport layer in
 * `main.ts` never needs to know about `TaggedError`s.
 */
import { randomUUID } from "node:crypto";
import { DateTime, Effect, Schema } from "effect";
import {
  Account,
  AuthResponse,
  Bio,
  BlogResponse,
  Comment,
  type CommentAuthor,
  CommentId,
  CommentsResponse,
  CreateCommentInput,
  CreatePostInput,
  FeedResponse,
  LoginInput,
  NonZeroPositiveInt,
  NotFoundError,
  Post,
  PostId,
  PostView,
  Profile,
  RegisterInput,
  SessionToken,
  Slug,
  UnauthorizedError,
  UpdatePostInput,
  Username,
  UserId,
  ValidationError,
  profileOfAccount,
} from "@realworld/domain";
import { decodeBody } from "./decode.js";
import { hashPassword, verifyPassword } from "./crypto.js";
import { domainErrorToResponse, type DomainError, type JsonResponse } from "./httpError.js";
import { optionalSession, requireSession } from "./session.js";
import { slugify } from "./slugify.js";
import { Store } from "./store.js";
import { postToView } from "./views.js";

const respondWith =
  <A, I>(schema: Schema.Schema<A, I>, status: number) =>
  (effect: Effect.Effect<A, DomainError, Store>): Effect.Effect<JsonResponse, never, Store> =>
    effect.pipe(
      Effect.flatMap((value) =>
        Schema.encode(schema)(value).pipe(
          Effect.map((body) => ({ status, body })),
          Effect.orDie,
        ),
      ),
      Effect.catchAll(domainErrorToResponse),
    );

const empty = (status: number): Effect.Effect<JsonResponse, never, Store> => Effect.succeed({ status, body: null });

const visibleToViewer = (post: Post, viewerId: UserId | undefined): boolean =>
  post.visibility === "public" || viewerId === post.authorId;

// -- Auth ---------------------------------------------------------------------------------------

export const register = (json: unknown) =>
  Effect.gen(function* () {
    const input = yield* decodeBody(RegisterInput, json);
    const store = yield* Store;
    const account = new Account({
      id: UserId.make(randomUUID()),
      username: input.username,
      email: input.email,
      displayName: input.displayName,
      bio: input.bio ?? Bio.make(""),
      passwordHash: yield* hashPassword(input.password),
      createdAt: DateTime.unsafeNow(),
    });
    yield* store.insertAccount(account);
    const token = SessionToken.make(randomUUID());
    yield* store.createSession(token, account.id);
    return { token, profile: profileOfAccount(account) };
  }).pipe(respondWith(AuthResponse, 201));

export const login = (json: unknown) =>
  Effect.gen(function* () {
    const input = yield* decodeBody(LoginInput, json);
    const store = yield* Store;
    const account = yield* store.findAccountByEmail(input.email);
    if (!account) return yield* Effect.fail(new UnauthorizedError({ message: "invalid email or password" }));
    const valid = yield* verifyPassword(input.password, account.passwordHash);
    if (!valid) return yield* Effect.fail(new UnauthorizedError({ message: "invalid email or password" }));
    const token = SessionToken.make(randomUUID());
    yield* store.createSession(token, account.id);
    return { token, profile: profileOfAccount(account) };
  }).pipe(respondWith(AuthResponse, 200));

export const currentUser = (authHeader: string | undefined) =>
  Effect.gen(function* () {
    const userId = yield* requireSession(authHeader);
    const store = yield* Store;
    const account = yield* store.getAccount(userId);
    return profileOfAccount(account);
  }).pipe(respondWith(Profile, 200));

// -- Blogs / feed ---------------------------------------------------------------------------------

export const getBlog = (usernameParam: string, authHeader: string | undefined) =>
  Effect.gen(function* () {
    const username = yield* decodeBody(Username, usernameParam);
    const viewerId = yield* optionalSession(authHeader);
    const store = yield* Store;
    const account = yield* store.findAccountByUsername(username);
    if (!account) return yield* Effect.fail(new NotFoundError({ resource: "User", id: usernameParam }));
    const posts = yield* store.listPostsByAuthor(account.id);
    const visible = posts.filter((post) => visibleToViewer(post, viewerId));
    const views = yield* Effect.forEach(visible, postToView);
    return { profile: profileOfAccount(account), posts: views };
  }).pipe(respondWith(BlogResponse, 200));

const clampedPageParam = (value: string | undefined, fallback: number, max: number): number => {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Math.min(max, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
};

export const listFeed = (pageParam: string | undefined, limitParam: string | undefined) =>
  Effect.gen(function* () {
    const page = clampedPageParam(pageParam, 1, 1_000_000);
    const limit = clampedPageParam(limitParam, 20, 100);
    const store = yield* Store;
    const posts = yield* store.listPosts();
    const publicPosts = posts
      .filter((post) => post.visibility === "public")
      .sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt));
    const pageOfPosts = publicPosts.slice((page - 1) * limit, (page - 1) * limit + limit);
    const views = yield* Effect.forEach(pageOfPosts, postToView);
    return { posts: views, page: NonZeroPositiveInt.make(page), limit: NonZeroPositiveInt.make(limit) };
  }).pipe(respondWith(FeedResponse, 200));

// -- Posts ------------------------------------------------------------------------------------

export const createPost = (authHeader: string | undefined, json: unknown) =>
  Effect.gen(function* () {
    const authorId = yield* requireSession(authHeader);
    const input = yield* decodeBody(CreatePostInput, json);
    const store = yield* Store;
    const now = DateTime.unsafeNow();
    const draft = new Post({
      id: PostId.make(randomUUID()),
      authorId,
      slug: slugify(input.title),
      title: input.title,
      body: input.body,
      visibility: input.visibility,
      createdAt: now,
      updatedAt: now,
    });
    const post = yield* store.insertPost(draft);
    return yield* postToView(post);
  }).pipe(respondWith(PostView, 201));

export const getPost = (slugParam: string, authHeader: string | undefined) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const viewerId = yield* optionalSession(authHeader);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (!visibleToViewer(post, viewerId)) return yield* Effect.fail(new NotFoundError({ resource: "Post", id: slugParam }));
    return yield* postToView(post);
  }).pipe(respondWith(PostView, 200));

export const updatePost = (slugParam: string, authHeader: string | undefined, json: unknown) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const requesterId = yield* requireSession(authHeader);
    const input = yield* decodeBody(UpdatePostInput, json);
    const store = yield* Store;
    const existing = yield* store.getPostBySlug(slug);
    const updated = yield* store.replacePost(
      existing.id,
      requesterId,
      (post) =>
        new Post({
          ...post,
          title: input.title ?? post.title,
          body: input.body ?? post.body,
          visibility: input.visibility ?? post.visibility,
          updatedAt: DateTime.unsafeNow(),
        }),
    );
    return yield* postToView(updated);
  }).pipe(respondWith(PostView, 200));

export const deletePost = (slugParam: string, authHeader: string | undefined) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const requesterId = yield* requireSession(authHeader);
    const store = yield* Store;
    const existing = yield* store.getPostBySlug(slug);
    yield* store.deletePost(existing.id, requesterId);
  }).pipe(
    Effect.flatMap(() => empty(204)),
    Effect.catchAll(domainErrorToResponse),
  );

// -- Comments ---------------------------------------------------------------------------------

export const listComments = (slugParam: string, authHeader: string | undefined) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const viewerId = yield* optionalSession(authHeader);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (!visibleToViewer(post, viewerId)) return yield* Effect.fail(new NotFoundError({ resource: "Post", id: slugParam }));
    const comments = yield* store.listCommentsByPost(post.id);
    return { comments };
  }).pipe(respondWith(CommentsResponse, 200));

export const createComment = (slugParam: string, authHeader: string | undefined, json: unknown) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const viewerId = yield* optionalSession(authHeader);
    const input = yield* decodeBody(CreateCommentInput, json);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (!visibleToViewer(post, viewerId)) return yield* Effect.fail(new NotFoundError({ resource: "Post", id: slugParam }));

    const author: CommentAuthor = yield* Effect.gen(function* () {
      if (viewerId) {
        const account = yield* store.getAccount(viewerId);
        return { _tag: "registered" as const, userId: account.id, username: account.username };
      }
      if (input.displayName) {
        return { _tag: "anonymous" as const, displayName: input.displayName };
      }
      return yield* Effect.fail(
        new ValidationError({
          message: "request body failed validation",
          issues: ["displayName: anonymous comments require a displayName"],
        }),
      );
    });

    const comment = new Comment({
      id: CommentId.make(randomUUID()),
      postId: post.id,
      author,
      body: input.body,
      createdAt: DateTime.unsafeNow(),
    });
    return yield* store.insertComment(comment);
  }).pipe(respondWith(Comment, 201));

export const deleteComment = (
  slugParam: string,
  commentIdParam: string,
  authHeader: string | undefined,
) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const commentId = yield* decodeBody(CommentId, commentIdParam);
    const requesterId = yield* requireSession(authHeader);
    const store = yield* Store;
    yield* store.getPostBySlug(slug);
    yield* store.deleteComment(commentId, requesterId);
  }).pipe(
    Effect.flatMap(() => empty(204)),
    Effect.catchAll(domainErrorToResponse),
  );
