/**
 * In-memory persistence for the demo server. A single `Ref<State>` holds everything; every
 * operation is an `Effect` so the HTTP layer never touches the mutable cell directly. This is
 * intentionally not a real database: the point of this project is exercising the `repo` HTTP
 * client library and Effect Schema, not building a storage layer.
 */
import { DateTime, Effect, Ref } from "effect";
import {
  Account,
  type AttachmentId,
  type AttachmentView,
  type CalendarEntryId,
  type CalendarTitle,
  type Comment,
  ConflictError,
  type DisplayName,
  type Email,
  type RepeatingEvent,
  type ServiceOrderId,
  type SingleEvent,
  type StreetAddress,
  ForbiddenError,
  NotFoundError,
  Post,
  type PostId,
  type Slug,
  type CommentId,
  type SessionToken,
  type UserId,
  type Username,
} from "@realworld/domain";

interface StoredAttachment {
  readonly meta: AttachmentView;
  readonly bytes: Uint8Array;
}

interface State {
  readonly accounts: Map<UserId, Account>;
  readonly usernameIndex: Map<Username, UserId>;
  readonly emailIndex: Map<Email, UserId>;
  readonly sessions: Map<SessionToken, UserId>;
  readonly posts: Map<PostId, Post>;
  readonly slugIndex: Map<Slug, PostId>;
  readonly comments: Map<CommentId, Comment>;
  readonly attachments: Map<AttachmentId, StoredAttachment>;
  /** Calendar entries the user created directly. */
  readonly calendarEvents: Map<CalendarEntryId, SingleEvent | RepeatingEvent>;
  /** Service orders, which are not calendar entries but are projected onto the calendar. */
  readonly serviceOrders: Map<ServiceOrderId, StoredServiceOrder>;
  readonly lastCacheRefresh: DateTime.Utc | undefined;
  /** How many times the search index has been asked to rebuild since this process started. */
  readonly reindexAttempts: number;
  /** Requests the search vendor has served since its last window; it rate-limits after a burst. */
  readonly searchRequests: number;
}

/** A service order lives in its own resource; the calendar only borrows it. */
export interface StoredServiceOrder {
  readonly id: ServiceOrderId;
  readonly assigneeId: UserId;
  readonly title: CalendarTitle;
  readonly customer: DisplayName;
  readonly address: StreetAddress;
  readonly scheduledFor: DateTime.Utc;
  readonly status: "dispatched" | "accepted" | "completed";
}

const emptyState: State = {
  accounts: new Map(),
  usernameIndex: new Map(),
  emailIndex: new Map(),
  sessions: new Map(),
  posts: new Map(),
  slugIndex: new Map(),
  comments: new Map(),
  attachments: new Map(),
  calendarEvents: new Map(),
  serviceOrders: new Map(),
  lastCacheRefresh: undefined,
  reindexAttempts: 0,
  searchRequests: 0,
};

export class Store extends Effect.Service<Store>()("Store", {
  effect: Effect.gen(function* () {
    const ref = yield* Ref.make(emptyState);

    // The caller never decides `role`: the very first account on a fresh server becomes the
    // admin, and every account after that is an ordinary member. Keeping that bootstrap rule
    // here, rather than in the route handler, means there is exactly one place that can ever
    // grant admin — a route handler cannot accidentally (or otherwise) hand it out.
    const insertAccount = (draft: Account) =>
      Ref.modify(ref, (state): readonly [Account | ConflictError, State] => {
        if (state.usernameIndex.has(draft.username)) {
          return [new ConflictError({ message: `username "${draft.username}" is already taken` }), state];
        }
        if (state.emailIndex.has(draft.email)) {
          return [new ConflictError({ message: `email "${draft.email}" is already registered` }), state];
        }
        const role = state.accounts.size === 0 ? "admin" : "member";
        const account = draft.role === role ? draft : new Account({ ...draft, role });
        const accounts = new Map(state.accounts).set(account.id, account);
        const usernameIndex = new Map(state.usernameIndex).set(account.username, account.id);
        const emailIndex = new Map(state.emailIndex).set(account.email, account.id);
        return [account, { ...state, accounts, usernameIndex, emailIndex }];
      }).pipe(
        Effect.flatMap((result) => (result instanceof Account ? Effect.succeed(result) : Effect.fail(result))),
      );

    const findAccountByEmail = (email: Email) =>
      Ref.get(ref).pipe(
        Effect.map((state) => {
          const id = state.emailIndex.get(email);
          return id ? state.accounts.get(id) : undefined;
        }),
      );

    const searchAccounts = (nameQuery: string, emailQuery: string) =>
      Ref.get(ref).pipe(
        Effect.map((state) => {
          const name = nameQuery.trim().toLowerCase();
          const email = emailQuery.trim().toLowerCase();
          return Array.from(state.accounts.values())
            .filter(
              (account) =>
                name === "" || account.username.toLowerCase().includes(name) || account.displayName.toLowerCase().includes(name),
            )
            .filter((account) => email === "" || account.email.toLowerCase().includes(email))
            .sort((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt));
        }),
      );

    const findAccountByUsername = (username: Username) =>
      Ref.get(ref).pipe(
        Effect.map((state) => {
          const id = state.usernameIndex.get(username);
          return id ? state.accounts.get(id) : undefined;
        }),
      );

    const getAccount = (id: UserId) =>
      Ref.get(ref).pipe(
        Effect.flatMap((state) => {
          const account = state.accounts.get(id);
          return account
            ? Effect.succeed(account)
            : Effect.fail(new NotFoundError({ resource: "Account", id }));
        }),
      );

    const createSession = (token: SessionToken, userId: UserId) =>
      Ref.update(ref, (state) => ({ ...state, sessions: new Map(state.sessions).set(token, userId) }));

    const resolveSession = (token: SessionToken) =>
      Ref.get(ref).pipe(Effect.map((state) => state.sessions.get(token)));

    const uniqueSlug = (state: State, desired: Slug): Slug => {
      if (!state.slugIndex.has(desired)) return desired;
      let suffix = 2;
      while (state.slugIndex.has(`${desired}-${suffix}` as Slug)) suffix += 1;
      return `${desired}-${suffix}` as Slug;
    };

    const insertPost = (draft: Post) =>
      Ref.modify(ref, (state) => {
        const slug = uniqueSlug(state, draft.slug);
        const post = slug === draft.slug ? draft : new Post({ ...draft, slug });
        const posts = new Map(state.posts).set(post.id, post);
        const slugIndex = new Map(state.slugIndex).set(post.slug, post.id);
        return [post, { ...state, posts, slugIndex }] as const;
      });

    const getPostBySlug = (slug: Slug) =>
      Ref.get(ref).pipe(
        Effect.flatMap((state) => {
          const id = state.slugIndex.get(slug);
          const post = id ? state.posts.get(id) : undefined;
          return post ? Effect.succeed(post) : Effect.fail(new NotFoundError({ resource: "Post", id: slug }));
        }),
      );

    const listPosts = () => Ref.get(ref).pipe(Effect.map((state) => Array.from(state.posts.values())));

    const listPostsByAuthor = (authorId: UserId) =>
      Ref.get(ref).pipe(
        Effect.map((state) => Array.from(state.posts.values()).filter((post) => post.authorId === authorId)),
      );

    const replacePost = (postId: PostId, requesterId: UserId, updater: (post: Post) => Post) =>
      Ref.modify(ref, (state): readonly [Post | NotFoundError | ForbiddenError, State] => {
        const existing = state.posts.get(postId);
        if (!existing) return [new NotFoundError({ resource: "Post", id: postId }), state];
        if (existing.authorId !== requesterId) {
          return [new ForbiddenError({ message: "only the author can modify this post" }), state];
        }
        const updated = updater(existing);
        const posts = new Map(state.posts).set(postId, updated);
        return [updated, { ...state, posts }];
      }).pipe(
        Effect.flatMap((result) => (result instanceof Post ? Effect.succeed(result) : Effect.fail(result))),
      );

    const deletePost = (postId: PostId, requesterId: UserId) =>
      Ref.modify(ref, (state): readonly [NotFoundError | ForbiddenError | undefined, State] => {
        const existing = state.posts.get(postId);
        if (!existing) return [new NotFoundError({ resource: "Post", id: postId }), state];
        if (existing.authorId !== requesterId) {
          return [new ForbiddenError({ message: "only the author can delete this post" }), state];
        }
        const posts = new Map(state.posts);
        posts.delete(postId);
        const slugIndex = new Map(state.slugIndex);
        slugIndex.delete(existing.slug);
        const comments = new Map(
          Array.from(state.comments).filter(([, comment]) => comment.postId !== postId),
        );
        return [undefined, { ...state, posts, slugIndex, comments }];
      }).pipe(Effect.flatMap((error) => (error ? Effect.fail(error) : Effect.void)));

    const insertComment = (comment: Comment) =>
      Ref.update(ref, (state) => ({ ...state, comments: new Map(state.comments).set(comment.id, comment) })).pipe(
        Effect.as(comment),
      );

    const listCommentsByPost = (postId: PostId) =>
      Ref.get(ref).pipe(
        Effect.map((state) =>
          Array.from(state.comments.values())
            .filter((comment) => comment.postId === postId)
            .sort((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt)),
        ),
      );

    const commentCountByPost = (postId: PostId) =>
      Ref.get(ref).pipe(
        Effect.map(
          (state) => Array.from(state.comments.values()).filter((comment) => comment.postId === postId).length,
        ),
      );

    const getComment = (commentId: CommentId) =>
      Ref.get(ref).pipe(
        Effect.flatMap((state) => {
          const comment = state.comments.get(commentId);
          return comment
            ? Effect.succeed(comment)
            : Effect.fail(new NotFoundError({ resource: "Comment", id: commentId }));
        }),
      );

    const deleteComment = (commentId: CommentId, requesterId: UserId) =>
      Ref.modify(ref, (state): readonly [NotFoundError | ForbiddenError | undefined, State] => {
        const comment = state.comments.get(commentId);
        if (!comment) return [new NotFoundError({ resource: "Comment", id: commentId }), state];
        const post = state.posts.get(comment.postId);
        const isCommentAuthor = comment.author._tag === "registered" && comment.author.userId === requesterId;
        const isPostAuthor = post?.authorId === requesterId;
        if (!isCommentAuthor && !isPostAuthor) {
          return [new ForbiddenError({ message: "only the comment or post author can delete this comment" }), state];
        }
        const comments = new Map(state.comments);
        comments.delete(commentId);
        return [undefined, { ...state, comments }];
      }).pipe(Effect.flatMap((error) => (error ? Effect.fail(error) : Effect.void)));

    const insertAttachment = (meta: AttachmentView, bytes: Uint8Array) =>
      Ref.update(ref, (state) => ({
        ...state,
        attachments: new Map(state.attachments).set(meta.id, { meta, bytes }),
      })).pipe(Effect.as(meta));

    const listAttachmentsByPost = (postId: PostId) =>
      Ref.get(ref).pipe(
        Effect.map((state) =>
          Array.from(state.attachments.values())
            .map((stored) => stored.meta)
            .filter((meta) => meta.postId === postId)
            .sort((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt)),
        ),
      );

    const getAttachment = (attachmentId: AttachmentId) =>
      Ref.get(ref).pipe(
        Effect.flatMap((state) => {
          const stored = state.attachments.get(attachmentId);
          return stored
            ? Effect.succeed(stored)
            : Effect.fail(new NotFoundError({ resource: "Attachment", id: attachmentId }));
        }),
      );

    const deleteAttachment = (attachmentId: AttachmentId, requesterId: UserId) =>
      Ref.modify(ref, (state): readonly [NotFoundError | ForbiddenError | undefined, State] => {
        const stored = state.attachments.get(attachmentId);
        if (!stored) return [new NotFoundError({ resource: "Attachment", id: attachmentId }), state];
        const post = state.posts.get(stored.meta.postId);
        if (post?.authorId !== requesterId) {
          return [new ForbiddenError({ message: "only the post's author can delete an attachment" }), state];
        }
        const attachments = new Map(state.attachments);
        attachments.delete(attachmentId);
        return [undefined, { ...state, attachments }];
      }).pipe(Effect.flatMap((error) => (error ? Effect.fail(error) : Effect.void)));

    const insertCalendarEvent = (event: SingleEvent | RepeatingEvent) =>
      Ref.update(ref, (state) => ({
        ...state,
        calendarEvents: new Map(state.calendarEvents).set(event.id, event),
      })).pipe(Effect.as(event));

    const listCalendarEvents = (ownerId: UserId) =>
      Ref.get(ref).pipe(
        Effect.map((state) =>
          Array.from(state.calendarEvents.values()).filter((event) => event.ownerId === ownerId),
        ),
      );

    const insertServiceOrder = (order: StoredServiceOrder) =>
      Ref.update(ref, (state) => ({
        ...state,
        serviceOrders: new Map(state.serviceOrders).set(order.id, order),
      })).pipe(Effect.as(order));

    const listServiceOrders = (assigneeId: UserId) =>
      Ref.get(ref).pipe(
        Effect.map((state) =>
          Array.from(state.serviceOrders.values()).filter((order) => order.assigneeId === assigneeId),
        ),
      );

    const countStats = () =>
      Ref.get(ref).pipe(
        Effect.map((state) => ({
          users: state.accounts.size,
          posts: state.posts.size,
          comments: state.comments.size,
        })),
      );

    /**
     * The search cluster is warm-standby: it answers `503` until it has been poked a couple of
     * times. Returning the attempt number lets the route decide between `503` and `202` without
     * keeping mutable state of its own.
     */
    const recordReindexAttempt = () =>
      Ref.modify(ref, (state) => {
        const reindexAttempts = state.reindexAttempts + 1;
        return [reindexAttempts, { ...state, reindexAttempts }] as const;
      });

    /**
     * The vendor allows a short burst and then answers `429` until its window rolls over. Modelled
     * as a counter rather than a clock so the behaviour is reproducible: every `burst + 1`-th
     * request is refused, and the count resets after the refusal.
     */
    const recordSearchRequest = (burst: number) =>
      Ref.modify(ref, (state) => {
        const searchRequests = state.searchRequests + 1;
        const limited = searchRequests > burst;
        return [limited, { ...state, searchRequests: limited ? 0 : searchRequests }] as const;
      });

    /** Bouncing the cluster puts it back into warm-standby, so it needs poking again. */
    const resetReindexAttempts = () => Ref.update(ref, (state) => ({ ...state, reindexAttempts: 0 }));

    const refreshCache = () =>
      Effect.gen(function* () {
        const now = DateTime.unsafeNow();
        yield* Ref.update(ref, (state) => ({ ...state, lastCacheRefresh: now }));
        return now;
      });

    return {
      insertAccount,
      findAccountByEmail,
      findAccountByUsername,
      searchAccounts,
      getAccount,
      createSession,
      resolveSession,
      insertPost,
      getPostBySlug,
      listPosts,
      listPostsByAuthor,
      replacePost,
      deletePost,
      insertComment,
      listCommentsByPost,
      commentCountByPost,
      getComment,
      deleteComment,
      insertAttachment,
      listAttachmentsByPost,
      getAttachment,
      deleteAttachment,
      insertCalendarEvent,
      listCalendarEvents,
      insertServiceOrder,
      listServiceOrders,
      countStats,
      recordReindexAttempt,
      recordSearchRequest,
      resetReindexAttempts,
      refreshCache,
    } as const;
  }),
}) {}
