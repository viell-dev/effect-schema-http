/**
 * Route handlers. Each one is an `Effect` that always succeeds with a `RouteResponse` — domain
 * errors are caught here and turned into their encoded body + status, so the transport layer in
 * `main.ts` never needs to know about `TaggedError`s.
 */
import { randomUUID } from "node:crypto";
import { DateTime, Effect, Schema } from "effect";
import {
  Account,
  AdminStatsFromBytes,
  adminUserViewOfAccount,
  AdminUsersResponse,
  AtomFeedFromString,
  AttachmentCaption,
  AttachmentId,
  AttachmentsResponse,
  AttachmentView,
  AuthResponse,
  BundleMetadata,
  Bio,
  BlogResponse,
  Comment,
  type CommentAuthor,
  CommentId,
  CommentsResponse,
  CreateCommentInput,
  CreatePostInput,
  CurrentUser,
  currentUserOfAccount,
  DiagnosticsReport,
  FeedResponse,
  Filename,
  ForbiddenError,
  ImportSummary,
  LegacyLoginForm,
  LoginInput,
  MimeType,
  NonNegativeInt,
  NotFoundError,
  PageQuery,
  Post,
  PostBody,
  PostExport,
  PostExportFromMarkdown,
  PostId,
  PostView,
  ReindexAccepted,
  RefreshCacheInput,
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
import { domainErrorToResponse, type DomainError, type RouteResponse } from "./httpError.js";
import { optionalSession, requireAdmin, requireSession } from "./session.js";
import { slugify } from "./slugify.js";
import { Store } from "./store.js";
import { postToView } from "./views.js";

const respondWith =
  <A, I>(schema: Schema.Schema<A, I>, status: number) =>
  (effect: Effect.Effect<A, DomainError, Store>): Effect.Effect<RouteResponse, never, Store> =>
    effect.pipe(
      Effect.flatMap((value) =>
        Schema.encode(schema)(value).pipe(
          Effect.map((body): RouteResponse => ({ kind: "json", status, body })),
          Effect.orDie,
        ),
      ),
      Effect.catchAll(domainErrorToResponse),
    );

const respondWithText =
  <A, I>(schema: Schema.Schema<A, I>, status: number, contentType: string) =>
  (effect: Effect.Effect<A, DomainError, Store>): Effect.Effect<RouteResponse, never, Store> =>
    effect.pipe(
      Effect.flatMap((value) =>
        Schema.encode(schema)(value).pipe(
          Effect.map((body): RouteResponse => ({ kind: "text", status, contentType, body: body as string })),
          Effect.orDie,
        ),
      ),
      Effect.catchAll(domainErrorToResponse),
    );

const respondWithBytes =
  <A, I>(schema: Schema.Schema<A, I>, status: number, contentType: string) =>
  (effect: Effect.Effect<A, DomainError, Store>): Effect.Effect<RouteResponse, never, Store> =>
    effect.pipe(
      Effect.flatMap((value) =>
        Schema.encode(schema)(value).pipe(
          Effect.map((body): RouteResponse => ({ kind: "bytes", status, contentType, body: body as Uint8Array })),
          Effect.orDie,
        ),
      ),
      Effect.catchAll(domainErrorToResponse),
    );

const empty = (status: number): Effect.Effect<RouteResponse, never, Store> =>
  Effect.succeed({ kind: "empty", status });

const visibleToViewer = (post: Post, viewerId: UserId | undefined): boolean =>
  post.visibility === "public" || viewerId === post.authorId;

// -- Auth ---------------------------------------------------------------------------------------

export const register = (json: unknown) =>
  Effect.gen(function* () {
    const input = yield* decodeBody(RegisterInput, json);
    const store = yield* Store;
    const draft = new Account({
      id: UserId.make(randomUUID()),
      username: input.username,
      email: input.email,
      displayName: input.displayName,
      bio: input.bio ?? Bio.make(""),
      passwordHash: yield* hashPassword(input.password),
      // The store, not this handler, decides the real role (see `Store.insertAccount`).
      role: "member",
      createdAt: DateTime.unsafeNow(),
    });
    const account = yield* store.insertAccount(draft);
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
    return currentUserOfAccount(account);
  }).pipe(respondWith(CurrentUser, 200));

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

export const listFeed = (pageParam: string | undefined, limitParam: string | undefined) =>
  Effect.gen(function* () {
    // `PageQuery` supplies its own defaults (via `Schema.optionalWith`) and validates positivity;
    // an absent query key defers to the default, so undefined values are omitted rather than passed through.
    const rawQuery: Record<string, unknown> = {};
    if (pageParam !== undefined) rawQuery.page = Number(pageParam);
    if (limitParam !== undefined) rawQuery.limit = Number(limitParam);
    const { page, limit } = yield* decodeBody(PageQuery, rawQuery);

    const store = yield* Store;
    const posts = yield* store.listPosts();
    const publicPosts = posts
      .filter((post) => post.visibility === "public")
      .sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt));
    const pageOfPosts = publicPosts.slice((page - 1) * limit, (page - 1) * limit + limit);
    const views = yield* Effect.forEach(pageOfPosts, postToView);
    return { posts: views, page, limit };
  }).pipe(respondWith(FeedResponse, 200));

/** Site URL used to build absolute `<link>`s in the Atom feed; the feed's own content has to be
 * self-contained since it is consumed by external readers, not just this project's own web app. */
const SITE_URL = process.env.SITE_URL ?? "http://localhost:5173";

export const getBlogFeed = (usernameParam: string) =>
  Effect.gen(function* () {
    const username = yield* decodeBody(Username, usernameParam);
    const store = yield* Store;
    const account = yield* store.findAccountByUsername(username);
    if (!account) return yield* Effect.fail(new NotFoundError({ resource: "User", id: usernameParam }));
    const posts = yield* store.listPostsByAuthor(account.id);
    const publicPosts = posts
      .filter((post) => post.visibility === "public")
      .sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt));
    return {
      title: account.displayName,
      updated: publicPosts[0]?.createdAt ?? account.createdAt,
      entries: publicPosts.map((post) => ({
        title: post.title,
        link: `${SITE_URL}/#/posts/${post.slug}`,
        updated: post.createdAt,
      })),
    };
  }).pipe(respondWithText(AtomFeedFromString, 200, "application/atom+xml; charset=utf-8"));

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

// -- Attachments ---------------------------------------------------------------------------------
//
// The newest feature on this backend, which is why it is the only one using multipart upload and
// raw-byte download instead of the JSON-only style everything above uses.

const MAX_ATTACHMENT_BYTES = 5_000_000;

export const listAttachments = (slugParam: string, authHeader: string | undefined) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const viewerId = yield* optionalSession(authHeader);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (!visibleToViewer(post, viewerId)) return yield* Effect.fail(new NotFoundError({ resource: "Post", id: slugParam }));
    const attachments = yield* store.listAttachmentsByPost(post.id);
    return { attachments };
  }).pipe(respondWith(AttachmentsResponse, 200));

export const uploadAttachment = (slugParam: string, authHeader: string | undefined, formData: FormData) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const requesterId = yield* requireSession(authHeader);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (post.authorId !== requesterId) {
      return yield* Effect.fail(new ForbiddenError({ message: "only the post's author can add attachments" }));
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return yield* Effect.fail(
        new ValidationError({ message: "request body failed validation", issues: ["file: a file field is required"] }),
      );
    }
    if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) {
      return yield* Effect.fail(
        new ValidationError({
          message: "request body failed validation",
          issues: [`file: must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes`],
        }),
      );
    }

    const filename = yield* decodeBody(Filename, file.name || "upload.bin");
    const contentType = yield* decodeBody(MimeType, file.type || "application/octet-stream");
    const captionField = formData.get("caption");
    const caption =
      typeof captionField === "string" && captionField.length > 0
        ? yield* decodeBody(AttachmentCaption, captionField)
        : undefined;

    const bytes = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
    const meta: AttachmentView = {
      id: AttachmentId.make(randomUUID()),
      postId: post.id,
      filename,
      contentType,
      size: NonNegativeInt.make(bytes.length),
      caption,
      createdAt: DateTime.unsafeNow(),
    };
    return yield* store.insertAttachment(meta, bytes);
  }).pipe(respondWith(AttachmentView, 201));

export const getAttachmentBytes = (
  slugParam: string,
  attachmentIdParam: string,
  authHeader: string | undefined,
) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const attachmentId = yield* decodeBody(AttachmentId, attachmentIdParam);
    const viewerId = yield* optionalSession(authHeader);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (!visibleToViewer(post, viewerId)) return yield* Effect.fail(new NotFoundError({ resource: "Post", id: slugParam }));
    const stored = yield* store.getAttachment(attachmentId);
    if (stored.meta.postId !== post.id) {
      return yield* Effect.fail(new NotFoundError({ resource: "Attachment", id: attachmentIdParam }));
    }
    return { bytes: stored.bytes, contentType: stored.meta.contentType };
  }).pipe(
    Effect.flatMap(({ bytes, contentType }) => Effect.succeed<RouteResponse>({ kind: "bytes", status: 200, contentType, body: bytes })),
    Effect.catchAll(domainErrorToResponse),
  );

export const deleteAttachment = (
  slugParam: string,
  attachmentIdParam: string,
  authHeader: string | undefined,
) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const attachmentId = yield* decodeBody(AttachmentId, attachmentIdParam);
    const requesterId = yield* requireSession(authHeader);
    const store = yield* Store;
    yield* store.getPostBySlug(slug);
    yield* store.deleteAttachment(attachmentId, requesterId);
  }).pipe(
    Effect.flatMap(() => empty(204)),
    Effect.catchAll(domainErrorToResponse),
  );

// -- Admin -----------------------------------------------------------------------------------
//
// The oldest features on this backend: `stats` predates the JSON API (see admin.ts), and
// `cache/refresh` is a bare RPC-style command with no response payload at all.

export const adminListUsers = (
  authHeader: string | undefined,
  nameParam: string | undefined,
  emailParam: string | undefined,
) =>
  Effect.gen(function* () {
    yield* requireAdmin(authHeader);
    const store = yield* Store;
    const accounts = yield* store.searchAccounts(nameParam ?? "", emailParam ?? "");
    return { users: accounts.map(adminUserViewOfAccount) };
  }).pipe(respondWith(AdminUsersResponse, 200));

export const adminStats = (authHeader: string | undefined) =>
  Effect.gen(function* () {
    yield* requireAdmin(authHeader);
    const store = yield* Store;
    const counts = yield* store.countStats();
    return {
      users: NonNegativeInt.make(counts.users),
      posts: NonNegativeInt.make(counts.posts),
      comments: NonNegativeInt.make(counts.comments),
      generatedAt: DateTime.unsafeNow(),
    };
  }).pipe(respondWithBytes(AdminStatsFromBytes, 200, "application/octet-stream"));

export const adminRefreshCache = (authHeader: string | undefined, json: unknown) =>
  Effect.gen(function* () {
    yield* requireAdmin(authHeader);
    const input = yield* decodeBody(RefreshCacheInput, json);
    const store = yield* Store;
    yield* store.refreshCache();
    if (input.reason) {
      // A real deployment would write this to an audit log; this demo just proves the reason
      // made it from the client's form field, through validation, to the server.
      console.log(`cache refresh requested: ${input.reason}`);
    }
  }).pipe(
    Effect.flatMap(() => empty(205)),
    Effect.catchAll(domainErrorToResponse),
  );

// -- Legacy request formats ---------------------------------------------------------------------
//
// Two endpoints kept alive for callers nobody can upgrade: a form-encoded login and an Atom
// importer. Both take a non-JSON *request* body, which is the mirror image of the feed and stats
// endpoints above — and in both cases the parsing is a schema's job, not this handler's.

export const legacyLogin = (form: Record<string, string>) =>
  Effect.gen(function* () {
    // `LegacyLoginForm` validates the same `Email`/`Password` brands the JSON login uses, plus the
    // `grant_type` literal this client has always sent, so the two endpoints cannot drift.
    const input = yield* decodeBody(LegacyLoginForm, form);
    const store = yield* Store;
    const account = yield* store.findAccountByEmail(input.email);
    if (!account) return yield* Effect.fail(new UnauthorizedError({ message: "invalid email or password" }));
    const valid = yield* verifyPassword(input.password, account.passwordHash);
    if (!valid) return yield* Effect.fail(new UnauthorizedError({ message: "invalid email or password" }));
    const token = SessionToken.make(randomUUID());
    yield* store.createSession(token, account.id);
    return { token, profile: profileOfAccount(account) };
  }).pipe(respondWith(AuthResponse, 200));

/**
 * Imports posts from an Atom document — decoded with `AtomFeedFromString`, the same schema
 * `getBlogFeed` above uses to *produce* one. The client encodes a domain value into that XML, this
 * decodes it back: one definition of the format, exercised in both directions across the wire.
 */
export const importAtom = (usernameParam: string, authHeader: string | undefined, xml: string) =>
  Effect.gen(function* () {
    const userId = yield* requireSession(authHeader);
    const username = yield* decodeBody(Username, usernameParam);
    const store = yield* Store;
    const account = yield* store.findAccountByUsername(username);
    if (!account) return yield* Effect.fail(new NotFoundError({ resource: "User", id: usernameParam }));
    if (account.id !== userId) {
      return yield* Effect.fail(new ForbiddenError({ message: "you can only import into your own blog" }));
    }

    const feed = yield* decodeBody(AtomFeedFromString, xml);
    const existing = yield* store.listPostsByAuthor(account.id);
    const existingTitles = new Set(existing.map((post) => post.title.toLowerCase()));

    const imported: Array<Slug> = [];
    let skipped = 0;
    for (const entry of feed.entries) {
      if (existingTitles.has(entry.title.toLowerCase())) {
        skipped += 1;
        continue;
      }
      const now = DateTime.unsafeNow();
      const post = yield* store.insertPost(
        new Post({
          id: PostId.make(randomUUID()),
          authorId: account.id,
          slug: slugify(entry.title),
          title: entry.title,
          // An Atom entry carries no body, only a link back to wherever it came from.
          body: PostBody.make(`Imported from ${entry.link}`),
          visibility: "public",
          createdAt: entry.updated,
          updatedAt: now,
        }),
      );
      existingTitles.add(post.title.toLowerCase());
      imported.push(post.slug);
    }

    return {
      imported: NonNegativeInt.make(imported.length),
      skipped: NonNegativeInt.make(skipped),
      slugs: imported,
    };
  }).pipe(respondWith(ImportSummary, 200));

// -- Export -------------------------------------------------------------------------------------

/**
 * One post, two representations at the same `200`. The client declares both as response rules
 * distinguished by a `content-type` matcher; this handler only has to answer honestly.
 */
export const exportPost = (slugParam: string, authHeader: string | undefined, accept: string | undefined) =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const viewerId = yield* optionalSession(authHeader);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (!visibleToViewer(post, viewerId)) {
      return yield* Effect.fail(new NotFoundError({ resource: "Post", id: slugParam }));
    }
    const author = yield* store.getAccount(post.authorId);
    return {
      slug: post.slug,
      title: post.title,
      author: author.username,
      body: post.body,
    };
  }).pipe(
    (effect) =>
      (accept ?? "").includes("text/markdown")
        ? effect.pipe(respondWithText(PostExportFromMarkdown, 200, "text/markdown; charset=utf-8"))
        : effect.pipe(respondWith(PostExport, 200)),
  );

// -- Search reindex -------------------------------------------------------------------------------

/**
 * Deliberately flaky: the warm-standby search cluster answers `503` with a `Retry-After` for its
 * first two pokes after a cold start, then accepts the job. `503` is one of the statuses the
 * `repo` library classifies as transient, so a client with a retry policy rides through this
 * without any special handling — see `packages/web/src/api.ts`.
 */
const REINDEX_WARMUP_ATTEMPTS = 2;

export const adminReindex = (authHeader: string | undefined) =>
  Effect.gen(function* () {
    yield* requireAdmin(authHeader);
    const store = yield* Store;
    const attempts = yield* store.recordReindexAttempt();
    if (attempts <= REINDEX_WARMUP_ATTEMPTS) {
      return {
        kind: "json",
        status: 503,
        headers: { "retry-after": "1" },
        body: { message: "search cluster is still warming up" },
      } satisfies RouteResponse;
    }
    const counts = yield* store.countStats();
    const body = yield* Schema.encode(ReindexAccepted)({
      indexed: NonNegativeInt.make(counts.posts),
      attempts: NonNegativeInt.make(attempts),
    }).pipe(Effect.orDie);
    return { kind: "json", status: 202, body } satisfies RouteResponse;
  }).pipe(Effect.catchAll(domainErrorToResponse));

// -- Attachment bundles ----------------------------------------------------------------------------

/**
 * Metadata and bytes for one attachment in a single multipart response — the only endpoint here
 * whose *response* is form data. Node has no multipart serializer, but `new Response(formData)`
 * has one built in, so the boundary and part framing come from the platform rather than from
 * string concatenation here.
 */
export const attachmentBundle = (
  slugParam: string,
  attachmentIdParam: string,
  authHeader: string | undefined,
): Effect.Effect<RouteResponse, never, Store> =>
  Effect.gen(function* () {
    const slug = yield* decodeBody(Slug, slugParam);
    const attachmentId = yield* decodeBody(AttachmentId, attachmentIdParam);
    const viewerId = yield* optionalSession(authHeader);
    const store = yield* Store;
    const post = yield* store.getPostBySlug(slug);
    if (!visibleToViewer(post, viewerId)) {
      return yield* Effect.fail(new NotFoundError({ resource: "Post", id: slugParam }));
    }
    const stored = yield* store.getAttachment(attachmentId);
    if (stored.meta.postId !== post.id) {
      return yield* Effect.fail(new NotFoundError({ resource: "Attachment", id: attachmentIdParam }));
    }

    const metadata = yield* Schema.encode(BundleMetadata)({
      filename: stored.meta.filename,
      contentType: stored.meta.contentType,
      size: stored.meta.size,
    }).pipe(Effect.orDie);

    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set(
      "file",
      new Blob([stored.bytes as Uint8Array<ArrayBuffer>], { type: stored.meta.contentType }),
      stored.meta.filename,
    );

    const serialized = new Response(form);
    const bytes = new Uint8Array(yield* Effect.promise(() => serialized.arrayBuffer()));
    return {
      kind: "bytes",
      status: 200,
      contentType: serialized.headers.get("content-type") ?? "multipart/form-data",
      body: bytes,
    } satisfies RouteResponse;
  }).pipe(Effect.catchAll(domainErrorToResponse));

/**
 * Answers either the modern JSON report or, when the modern subsystem is unhealthy, the original
 * watchdog's plain-text dump. The second shape is deliberately something no client models: it is
 * what the `repo` library's `UnhandledResponse` exists for.
 */
export const adminDiagnostics = (
  authHeader: string | undefined,
  degraded: boolean,
): Effect.Effect<RouteResponse, never, Store> =>
  Effect.gen(function* () {
    yield* requireAdmin(authHeader);
    if (!degraded) {
      return yield* Effect.succeed({
        subsystem: "modern" as const,
        healthy: true,
        checkedAt: DateTime.unsafeNow(),
      }).pipe(respondWith(DiagnosticsReport, 200));
    }
    const store = yield* Store;
    const counts = yield* store.countStats();
    const dump = [
      "WATCHDOG DIAGNOSTIC DUMP",
      "modern subsystem: UNREACHABLE",
      `accounts=${counts.users} posts=${counts.posts} comments=${counts.comments}`,
      "advice: restart the modern collector",
    ].join("\n");
    return {
      kind: "text",
      status: 503,
      contentType: "text/plain; charset=utf-8",
      body: dump,
    } satisfies RouteResponse;
  }).pipe(Effect.catchAll(domainErrorToResponse));
