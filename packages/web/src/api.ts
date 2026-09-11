/**
 * Every server endpoint declared once with the `repo` library's `createApi`/`createRequest`.
 * This is the actual object of this test project: everything else exists to give this file
 * something realistic to call. Endpoints are grouped to show which wire style each one uses -
 * this "long-lived" backend accreted a mix of them rather than staying uniformly JSON.
 */
import { Schema } from "effect";
import {
  AdminStatsFromBytes,
  AdminUsersResponse,
  AtomFeedFromString,
  AttachmentsResponse,
  AttachmentView,
  AuthResponse,
  BlogResponse,
  Comment,
  CommentsResponse,
  ConflictError,
  CreateCommentInput,
  CreatePostInput,
  CurrentUser,
  DiagnosticsReport,
  FeedResponse,
  ForbiddenError,
  ImportSummary,
  LegacyLoginForm,
  LoginInput,
  NotFoundError,
  PostExport,
  PostExportFromMarkdown,
  PostView,
  RefreshCacheInput,
  RegisterInput,
  ReindexAccepted,
  UnauthorizedError,
  UpdatePostInput,
  ValidationError,
} from "@realworld/domain";
import { createApi, RequestBody, response, ResponseBody } from "viell-effect-schema-http";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

/**
 * The five domain errors are declared once as API-wide default response rules. Every endpoint
 * inherits them, so a 404 from a route nobody thought to override still decodes into a typed
 * `NotFoundError` instead of falling through to `UnhandledResponse`. Reusing the exact
 * `Schema.TaggedError` classes from `@realworld/domain` means the client decodes the identical
 * shape the server encoded — there is exactly one definition of what a `NotFoundError` looks like.
 */
const api = createApi(API_BASE_URL, {
  responses: [
    response({ _tag: "ValidationError", status: 400 }, ValidationError),
    response({ _tag: "UnauthorizedError", status: 401 }, UnauthorizedError),
    response({ _tag: "ForbiddenError", status: 403 }, ForbiddenError),
    response({ _tag: "NotFoundError", status: 404 }, NotFoundError),
    response({ _tag: "ConflictError", status: 409 }, ConflictError),
  ] as const,
});

/** `204 No Content` responses must opt into `ResponseBody.none` per the library's README: the
 * default JSON codec rejects empty bodies, and `none` cannot be installed as an implicit default. */
const noContent = response({ _tag: "noContent", status: 204 }, Schema.Void, { codec: ResponseBody.none });

// -- Auth -----------------------------------------------------------------------------------

export const register = api.createRequest({
  method: "POST",
  path: "/api/users",
  body: RegisterInput,
  responses: [response({ _tag: "created", status: 201 }, AuthResponse)],
});

export const login = api.createRequest({
  method: "POST",
  path: "/api/users/login",
  body: LoginInput,
  responses: [response({ _tag: "ok", status: 200 }, AuthResponse)],
});

/**
 * The same credentials, `application/x-www-form-urlencoded` instead of JSON. `RequestBody.urlParams`
 * takes a record of coercible values, and `LegacyLoginForm`'s encoded type — a struct of plain
 * strings — already *is* one, so no transformation is needed: the same "identity schema" trick
 * that makes `Schema.instanceOf(FormData)` work for multipart, one wire format down.
 */
export const legacyLogin = api.createRequest({
  method: "POST",
  path: "/api/users/login/legacy",
  body: LegacyLoginForm,
  bodyCodec: RequestBody.urlParams,
  responses: [response({ _tag: "ok", status: 200 }, AuthResponse)],
});

export const currentUser = api.createRequest({
  method: "GET",
  path: "/api/user",
  responses: [response({ _tag: "ok", status: 200 }, CurrentUser)],
});

// -- Blogs / feed ------------------------------------------------------------------------------

export const getBlog = api.createRequest({
  method: "GET",
  path: "/api/blogs/:username",
  responses: [response({ _tag: "ok", status: 200 }, BlogResponse)],
});

/** Text, not JSON: this backend's Atom feed predates its JSON API. The header condition picks
 * this rule only for an `atom+xml` response, matching the README's "more header conditions are
 * more specific" precedence rule (relevant if this endpoint ever grows a JSON alternative). */
export const getBlogFeed = api.createRequest({
  method: "GET",
  path: "/api/blogs/:username/feed.atom",
  responses: [
    response(
      {
        _tag: "ok",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("application/atom+xml") ?? false },
      },
      AtomFeedFromString,
      { codec: ResponseBody.text },
    ),
  ],
});

/**
 * The feed endpoint's mirror image, and the reason `AtomFeedFromString` is worth defining as a
 * transformation rather than a parser: here the *client* encodes a domain value into that XML with
 * `RequestBody.text`, and the server decodes it with the identical schema. One definition of the
 * format, used in four places — encode and decode, on both ends.
 *
 * The explicit `content-type` matters: `RequestBody.text(contentType)` writes it, and without it
 * this would be announced as `text/plain`.
 */
export const importBlogFeed = api.createRequest({
  method: "POST",
  path: "/api/blogs/:username/import.atom",
  body: AtomFeedFromString,
  bodyCodec: RequestBody.text("application/atom+xml"),
  responses: [response({ _tag: "ok", status: 200 }, ImportSummary)],
});

export const listFeed = api.createRequest({
  method: "GET",
  path: "/api/posts",
  responses: [response({ _tag: "ok", status: 200 }, FeedResponse)],
});

// -- Posts ----------------------------------------------------------------------------------

export const createPost = api.createRequest({
  method: "POST",
  path: "/api/posts",
  body: CreatePostInput,
  responses: [response({ _tag: "created", status: 201 }, PostView)],
});

export const getPost = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug",
  responses: [response({ _tag: "ok", status: 200 }, PostView)],
});

export const updatePost = api.createRequest({
  method: "PUT",
  path: "/api/posts/:slug",
  body: UpdatePostInput,
  responses: [response({ _tag: "ok", status: 200 }, PostView)],
});

/**
 * The one endpoint here whose response shape genuinely varies at runtime, and therefore the one
 * place the library's response-rule precedence is load-bearing rather than decorative. Two rules
 * share `status: 200` and are separated only by a `content-type` matcher; a third matches any 5xx
 * through a status *predicate*. Per the library's documented ranking — "rules with more matched
 * headers rank first. Among rules with the same number of matched headers, an exact status ranks
 * above a status predicate" — the two header-bearing rules are tried first, and the predicate rule
 * can never shadow them no matter what order they are declared in.
 *
 * `Accept` is the caller's job: a rule-specific codec does not change the request header, because
 * rules are selected after the response arrives. `exportPostAs` below sets it per call site.
 */
export const exportPost = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug/export",
  responses: [
    response(
      {
        _tag: "json",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("application/json") ?? false },
      },
      PostExport,
    ),
    response(
      {
        _tag: "markdown",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("text/markdown") ?? false },
      },
      PostExportFromMarkdown,
      { codec: ResponseBody.text },
    ),
    response(
      { _tag: "serverError", status: (status) => status >= 500 },
      Schema.Struct({ message: Schema.String }),
    ),
  ] as const,
});

/** Picks a representation by setting `Accept`; the rules above then select the matching decoder. */
export const exportPostAs = (slug: string, format: "json" | "markdown") =>
  exportPost({ slug }).setHeader("accept", format === "markdown" ? "text/markdown" : "application/json");

export const deletePost = api.createRequest({
  method: "DELETE",
  path: "/api/posts/:slug",
  responses: [noContent],
});

// -- Comments ---------------------------------------------------------------------------------

export const listComments = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug/comments",
  responses: [response({ _tag: "ok", status: 200 }, CommentsResponse)],
});

export const createComment = api.createRequest({
  method: "POST",
  path: "/api/posts/:slug/comments",
  body: CreateCommentInput,
  responses: [response({ _tag: "created", status: 201 }, Comment)],
});

export const deleteComment = api.createRequest({
  method: "DELETE",
  path: "/api/posts/:slug/comments/:commentId",
  responses: [noContent],
});

// -- Attachments ------------------------------------------------------------------------------
//
// The newest feature on this backend: multipart upload in, raw bytes out. Neither wire style
// appears anywhere else in this API.

export const listAttachments = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug/attachments",
  responses: [response({ _tag: "ok", status: 200 }, AttachmentsResponse)],
});

/** `Schema.instanceOf(FormData)` is an identity schema — Type and Encoded are both `FormData` —
 * so `RequestBody.formData`'s `Input: FormData` requirement is satisfied without any transform:
 * the caller builds a real `FormData` and hands it to `.setBody` as-is. */
export const uploadAttachment = api.createRequest({
  method: "POST",
  path: "/api/posts/:slug/attachments",
  body: Schema.instanceOf(FormData),
  bodyCodec: RequestBody.formData,
  responses: [response({ _tag: "created", status: 201 }, AttachmentView)],
});

/** `Schema.Uint8ArrayFromSelf` is the raw-bytes counterpart of `Schema.instanceOf(FormData)`
 * above: an identity schema so the decoded body is exactly the `Uint8Array` `ResponseBody.uint8Array`
 * produced, with no further parsing — this is a real file's bytes, not a payload smuggled as bytes. */
export const getAttachmentBytes = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug/attachments/:attachmentId",
  responses: [
    response({ _tag: "ok", status: 200 }, Schema.Uint8ArrayFromSelf, { codec: ResponseBody.uint8Array }),
  ],
});

/**
 * The only endpoint here whose *response* is form data. `ResponseBody.formData` hands the decoded
 * `FormData` straight to `Schema.instanceOf(FormData)` — the same identity schema the upload
 * endpoint uses for its request — and the caller pulls the parts out itself, because what a
 * multipart response's parts mean is application knowledge, not something a codec can infer.
 */
export const getAttachmentBundle = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug/attachments/:attachmentId/bundle",
  headers: { accept: "multipart/form-data" },
  responses: [
    response({ _tag: "ok", status: 200 }, Schema.instanceOf(FormData), { codec: ResponseBody.formData }),
  ],
});

export const deleteAttachment = api.createRequest({
  method: "DELETE",
  path: "/api/posts/:slug/attachments/:attachmentId",
  responses: [noContent],
});

// -- Admin ----------------------------------------------------------------------------------
//
// `stats` and `cache/refresh` are the oldest features on this backend (see their comments below).
// `users`, by contrast, is the newest: a name/email-filterable directory, i.e. the "datatable with
// a filter form" shape `makeRequestGate` is documented for. See `packages/web/src/usersGate.ts` -
// it is not declared here as a plain endpoint call because every filter keystroke needs the
// gate's interruption behavior, not just another `toEffect` call.

export const adminListUsers = api.createRequest({
  method: "GET",
  path: "/api/admin/users",
  responses: [response({ _tag: "ok", status: 200 }, AdminUsersResponse)],
});

export const adminStats = api.createRequest({
  method: "GET",
  path: "/api/admin/stats",
  responses: [response({ _tag: "ok", status: 200 }, AdminStatsFromBytes, { codec: ResponseBody.uint8Array })],
});

/**
 * The warm-standby search cluster answers `503` with a `Retry-After` until it is up, which is
 * exactly the case the library's retry policy already classifies as transient — no custom `while`
 * predicate needed. `times: 3` permits four attempts in total, `respectRetryAfter` (the default)
 * treats the header as a *minimum* delay over the jittered backoff, and the intermediate `503`
 * bodies are drained by the library rather than buffered.
 *
 * Retries are declared here, on the endpoint, rather than at each call site precisely because this
 * endpoint's flakiness is a property of the endpoint. It is also safe to replay: reindexing is
 * idempotent, which is the question the library's docs tell you to answer before enabling retries
 * on a non-GET method.
 */
export const adminReindex = api.createRequest({
  method: "POST",
  path: "/api/admin/search/reindex",
  retry: { times: 3 },
  responses: [
    response({ _tag: "accepted", status: 202 }, ReindexAccepted),
    response({ _tag: "warmingUp", status: 503 }, Schema.Struct({ message: Schema.String })),
  ] as const,
});

/**
 * The one endpoint here that deliberately does *not* map everything it can receive. The modern
 * subsystem answers the JSON below; the original watchdog answers a plain-text dump at `503` that
 * nobody has ever modelled, and inventing a schema for it would be pretending to understand a
 * format that is not specified anywhere.
 *
 * So that second shape is left unmapped and becomes an `UnhandledResponse` — and the call site
 * asks for `unhandledResponseBody: "retain"`, which transfers ownership of the live body to the
 * caller instead of draining it. The admin page then either reads it (see `pages/admin.ts`) or
 * runs `error.discard`; per the library's docs, a retained body must be one or the other.
 */
export const adminDiagnostics = api.createRequest({
  method: "GET",
  path: "/api/admin/diagnostics",
  unhandledResponseBody: "retain",
  responses: [response({ _tag: "ok", status: 200 }, DiagnosticsReport)],
});

/** `205 Reset Content`, not `204 No Content`: per HTTP semantics this tells the caller to reset
 * the view/form that submitted the request, which is exactly what the admin page's "reason"
 * field does on success. Still `ResponseBody.none` either way — the body is empty regardless of
 * which of the two statuses is used. */
export const adminRefreshCache = api.createRequest({
  method: "POST",
  path: "/api/admin/cache/refresh",
  body: RefreshCacheInput,
  responses: [response({ _tag: "reset", status: 205 }, Schema.Void, { codec: ResponseBody.none })],
});
