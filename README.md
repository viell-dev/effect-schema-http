# realworld-schema-http

A small "realworld"-style multi-user blog — per-user blogs, login, public/draft/private posts,
comments from registered or anonymous authors, file attachments, a legacy Atom feed, and an admin
panel — built specifically to exercise [`viell-effect-schema-http`](../repo) (a lazy, schema-driven
HTTP client for [Effect](https://effect.website/)) and advanced
[Effect Schema](https://effect.website/docs/schema/introduction/) features under realistic
conditions. The library and Effect Schema are the actual subject of this project; the blog is only
a vehicle for using both the way a real application would — including the parts of a real
application that accreted over time and never ended up uniform. The blog CRUD alone only needed
JSON in and JSON out; the attachments/feed/admin features exist specifically to make this backend
"look" long-lived by mixing in the request/response codecs a pure-JSON API would never need
(`ResponseBody.text`, `ResponseBody.uint8Array`, `RequestBody.formData`, `ResponseBody.none`,
and an intentionally non-standard `205` status).

This is a local, no-remote git repository. Every commit is a real checkpoint (`git log` tells the
story better than this document does), and the final third of this README is a candid writeup of
what worked well and what didn't while building it.

## Architecture

```
packages/
  domain/   Effect Schemas shared by server and client: branded ids and primitives,
            entities (Account, Post, Comment), wire DTOs, and Schema.TaggedError domain errors.
  server/   Plain node:http + a hand-rolled router over Effect for business logic.
            In-memory Ref-backed store (users, posts, comments). No database.
  web/      A vanilla TypeScript + Vite SPA. Every server call goes through
            viell-effect-schema-http's createApi/createRequest/response().
vendor/     The packed viell-effect-schema-http-0.1.0-beta.1 tarball, installed by
            server and web as a `file:` dependency (see vendor/README.md).
```

**Why plain `node:http` for the server, not `@effect/platform`'s `HttpRouter`:** the point of this
project is `viell-effect-schema-http` (the *client*) and Effect Schema, not evaluating an unfamiliar
server framework. A hand-rolled router keeps the server's own risk surface small and puts the time
budget on the client library and the schemas instead. Business logic is still ordinary Effect
(`Effect.gen`, `Schema.TaggedError`, an `Effect.Service`-based in-memory store).

**Why no frontend framework:** the UI needs (a feed, a couple of forms, a post detail view) are
simple enough that React/Vue would only add build tooling without adding value here. A ~40-line
`h()` DOM builder (`packages/web/src/dom.ts`) that always uses `textContent`/`createTextNode` for
string children — never `innerHTML` — was enough, and it keeps post bodies and comments (arbitrary
user input) from ever being interpreted as markup.

**Persistence is in-memory** (`packages/server/src/store.ts`, a single `Ref<State>`). Restarting the
server discards all data. Adding a real database was out of scope for what this project is testing.

**The "long-lived backend" features and which codec each one exercises:**

| Feature | Endpoint(s) | Codec |
| --- | --- | --- |
| Post attachments (upload) | `POST /api/posts/:slug/attachments` | `RequestBody.formData` |
| Post attachments (download) | `GET /api/posts/:slug/attachments/:id` | `ResponseBody.uint8Array` (raw file bytes) |
| Per-blog Atom feed | `GET /api/blogs/:username/feed.atom` | `ResponseBody.text` (XML) |
| Admin stats | `GET /api/admin/stats` | `ResponseBody.uint8Array` (bytes that are secretly JSON) |
| Admin cache refresh | `POST /api/admin/cache/refresh` | `ResponseBody.none`, status `205` not `204` |

The blog/post/comment CRUD underneath all of this is plain JSON in, JSON out — the default codec
the library needs no configuration for at all.

## Running it

Requires Node.js 22+ and pnpm 10 (see `package.json#packageManager`).

```sh
pnpm install
pnpm --filter @realworld/server run dev   # http://localhost:4000
pnpm --filter @realworld/web run dev      # http://localhost:5173 (Vite prints the exact port)
```

Open the Vite URL, register an account, write a post, comment on it while signed out in another
tab. `VITE_API_BASE_URL` overrides the server URL the web app targets (defaults to
`http://localhost:4000`).

Tests: `pnpm --filter @realworld/domain run test` (14 tests) and
`pnpm --filter @realworld/server run test` (10 tests) run under Vitest. The web package has no
automated tests; it was verified by driving a real, system-installed Chromium through
`playwright-core` against both dev servers, in two passes: (1) register → post → comment signed in
→ sign out → comment anonymously → create a private post → confirm it 404s for a signed-out
visitor instead of leaking that it exists; (2) first-registered-user-becomes-admin → upload a real
PNG attachment and see it render as an inline preview → view the same post through its Atom feed →
refresh the admin cache and watch the reason field clear itself on the `205` response → confirm a
second user gets neither the admin nav link nor access to `/admin`. No browser-automation tool was
preinstalled in this environment, so that was set up ad hoc for this verification pass; it is not
part of the committed project.

## Effect Schema tricks exercised

All in `packages/domain/src`, used identically by both `server` and `web`:

- **Branded types everywhere**: `UserId`/`PostId`/`CommentId`/`SessionToken` are `Schema.UUID`
  branded per-entity (`ids.ts`); `NonZeroPositiveInt` (pagination), `Username`, `Email`, `Slug`,
  `Password`, `PostTitle`, `PostBody`, `CommentBody`, `DisplayName`, `Bio` are all
  `Schema.filter`-refined and branded (`primitives.ts`, `post.ts`, `comment.ts`). A `PostId` and a
  `CommentId` are both plain strings at runtime but cannot be passed to each other's slots at
  compile time.
- **Custom `arbitrary` annotations** (`primitives.ts`, `ids.ts`) replace the default
  filter-and-retry fast-check derivation with direct generators (`fc.uuid()` for ids, a
  constrained-alphabet generator for `Username`/`Slug`/`Email`) — faster, and correct by
  construction instead of relying on rejection sampling against a regex.
- **Custom `pretty` annotations** redact `Password` and `PasswordHash` (`Password(<redacted>)`)
  so a decoded request body can be logged or printed for debugging without ever leaking a secret —
  verified in `schemas.test.ts` by asserting the plaintext never appears in the pretty output.
- **Custom `equivalence` annotation** on `PostView` (`post.ts`) treats two views as "the same post"
  when identity and content match, deliberately ignoring `updatedAt`/`createdAt` — an explicit
  override of the fully-structural equivalence every `Schema.Struct` gets for free, useful for
  tests/logs that shouldn't fail on clock-skew-sized timestamp noise.
- **`Schema.TaggedError`** for every domain error (`ValidationError`, `UnauthorizedError`,
  `ForbiddenError`, `NotFoundError`, `ConflictError`) — simultaneously a normal Effect failure
  channel member on the server and a `Schema` the client decodes as a typed `response()` rule. One
  definition, two consumers, matching the exact pattern the library's own README quick-start uses
  for its `NotFound` example.
- **`Schema.Class`** for server-side entities (`Account`, `Post`, `Comment`) and **`Schema.Union`**
  for `_tag`-discriminated values (`PostVisibility` is a plain literal union; `CommentAuthor` is a
  `_tag`-discriminated union of `registered`/`anonymous`, matched with `Match.tag`/`Match.exhaustive`
  on the client).
- **`Schema.DateTimeUtc`** for every timestamp — decodes an ISO string straight into an Effect
  `DateTime.Utc`, not a bare `Date`.
- **`Schema.optionalWith(..., { default: ... })`** for `PageQuery` (`api.ts`) — an absent query
  parameter gets a real default (`page: 1`, `limit: 20`) applied during decode, not a hand-rolled
  fallback; see `packages/server/src/routes.ts`'s `listFeed`.
- **Symmetric client/server validation**: `packages/server/src/decode.ts` and
  `packages/web/src/decodeForm.ts` are two independent ~15-line functions that do the same thing —
  `Schema.decodeUnknown`/`Schema.decodeUnknownEither` plus `ParseResult.ArrayFormatter` for a
  readable issue list — one for a JSON request body, one for form input. Same schemas, same
  validation semantics, both ends.
- **Bidirectional `Schema.transformOrFail`** for two different non-JSON wire formats, each defined
  once and used in both directions: `AtomFeedFromString` (`feed.ts`) pairs `Schema.String` with a
  plain struct — the server calls `Schema.encode` on it to *produce* the feed's XML, the client's
  `response()` rule calls `Schema.decode` (via `ResponseBody.text`) to *parse* the same shape back,
  and it deliberately parses only the exact narrow shape its own `encode` emits, not general XML.
  `AdminStatsFromBytes` (`admin.ts`) does the same one layer further down: `Schema.Uint8ArrayFromSelf`
  paired with a struct, because this "legacy" endpoint's bytes are secretly UTF-8 JSON. Both are
  round-tripped in `feed.test.ts`/`admin.test.ts`, including a case that fails to decode malformed
  input.
- **Identity schemas as the join between a domain type and a codec's `Input` type**:
  `Schema.instanceOf(FormData)` (Type = Encoded = `FormData`) satisfies `RequestBody.formData`'s
  `Input: FormData` with no transform at all — the caller's real `FormData` goes straight to
  `.setBody`. `Schema.Uint8ArrayFromSelf` does the same for `ResponseBody.uint8Array` when nothing
  needs to further parse the bytes (an attachment download, as opposed to `AdminStatsFromBytes`,
  which does parse them). See `packages/web/src/api.ts`'s `uploadAttachment`/`getAttachmentBytes`.
- **Extending a schema by reusing its `.fields`**: `CurrentUser` (`user.ts`) is
  `Schema.Struct({ ...Profile.fields, role: AdminRole })` — a real reuse of `Profile`'s field
  definitions for the one extra fact only the authenticated user can see about themselves, not a
  hand-copied duplicate that could drift.

## Using `viell-effect-schema-http`: what worked well

- **The core API is exactly as pleasant as the README promises.** `createApi(baseUrl, { responses
  })` plus `api.createRequest({ method, path, body, responses })` produces a fully-typed, callable,
  pipeable endpoint. Every one of the nineteen endpoints in `packages/web/src/api.ts` was declared
  this way — across five different response/request codecs — and it stayed easy to read even with
  five shared error rules inherited by every one of them.
- **Response unions as ordinary success values is a genuinely good design.** Modeling a `404` as a
  decoded, typed member of the *success* channel (not a thrown error) means `Match.tag` handles
  "the post doesn't exist" and "here is the post" in the same exhaustive `Match.value(...).pipe(...)`
  chain. `packages/web/src/errors.ts`'s `domainErrorMessage` is a single ~15-line function, written
  once, reused by all five forms (login, register, post editor, comment form, post detail) because
  every endpoint shares the same five error rules.
- **Reusing the exact `Schema.TaggedError` class on both sides eliminates an entire class of bugs.**
  The server encodes a `NotFoundError` instance with `Schema.encode(NotFoundError)`; the client
  decodes the same class via `response({ _tag: "NotFoundError", status: 404 }, NotFoundError)`.
  There is exactly one place that defines what a `NotFoundError` looks like on the wire. This is the
  headline feature of building both ends with the same Effect Schema definitions, and it worked
  without a single hiccup.
- **`RequestPlan.setBody` only accepting an already-schema-typed value is a real safety net, not
  just ceremony.** It is a compile error to hand it a raw form object; the value has to come from
  `Schema.decodeUnknownEither` (or equivalent) first. This repeatedly caught "forgot to validate"
  mistakes while writing the forms in `packages/web/src/pages/*.ts`, at compile time, before any
  request was ever sent.
- **Path-template type inference just works.** `getPost({ slug })` against a `/api/posts/:slug`
  declaration is fully typed from the string literal — a typo'd or missing param is a compile
  error, and a path with no `:params` (like `/api/posts`) correctly makes the endpoint callable
  with zero arguments (`listFeed()`).
- **Immutable setters compose into small, genuinely reusable combinators.** `withAuth` (attaching a
  bearer token) is an 8-line function written once against a minimal structural type
  (`{ setHeader }`) and it works across every endpoint regardless of that endpoint's concrete
  `Body`/`Rules`/`BodyReady` type parameters — no per-endpoint casting needed anywhere it's used.
- **TSDoc coverage let this whole client layer get built without reading the library's
  implementation.** Per the project's own request, every endpoint, setter, and codec choice below
  was written from `dist/request.d.ts`'s TSDoc and the README alone; `src/request.ts` was never
  opened. For a beta library, that is a strong signal.
- **The documented beta-distribution flow (`pnpm pack` + a `file:` dependency on the tarball) worked
  on the first try**, in two different consumer packages, with no registry or network surprises.
- **A header matcher for content-type-based response selection worked exactly as documented on the
  first attempt.** `getBlogFeed`'s response rule matches `content-type: (value) =>
  value?.startsWith("application/atom+xml") ?? false` — copied almost verbatim from the README's
  own "Response rules" example — and correctly selected the `AtomFeedFromString`/`ResponseBody.text`
  rule. (This particular endpoint only ever returns one shape, so the header condition is not
  load-bearing here; it is included to exercise and confirm the pattern the README documents for
  when an endpoint's content-type genuinely varies by response.)
- **Non-standard status codes need zero special support.** Answering `205 Reset Content` instead of
  `204 No Content` for the admin cache-refresh RPC (`response({ _tag: "reset", status: 205 },
  Schema.Void, { codec: ResponseBody.none })`) worked identically to every other status — `status`
  is just a `number`, and the library never assumes a fixed enum of "known" HTTP codes.
- **`Schema.instanceOf`/`Schema.Uint8ArrayFromSelf` as identity schemas make `RequestBody.formData`
  and `ResponseBody.uint8Array` trivial to wire up once you know the trick** (see the Effect Schema
  section above) — no custom codec, no transform, just a schema whose `Type` already matches the
  codec's `Input`/output.

## Using `viell-effect-schema-http`: friction, gaps, and one real bug we hit

- **`FetchHttpClient` sends a `traceparent` header on every request, and the library's docs never
  mention it.** This broke every cross-origin call from the browser during manual verification: a
  CORS server with a fixed `Access-Control-Allow-Headers` allow-list (a completely standard pattern
  — see the *first* version of `packages/server/src/main.ts` in git history) rejects the preflight,
  and the failure surfaces only as an opaque `RequestError: Transport error (...)` with no
  indication that CORS, let alone this specific header, was the cause. Diagnosing it required
  opening the browser console for the real (non-Effect-wrapped) message and instrumenting a raw
  `fetch()` call to compare. This is technically `@effect/platform`'s tracing propagation rather
  than code in this library, but it is exactly the kind of thing a consumer hits *only* because of
  how this library uses `HttpClient.HttpClient`, and the README's browser-facing "Quick start" and
  "Providers and cancellation" sections are the natural place to warn about it. **Fix applied on our
  side:** the demo server now reflects `Access-Control-Request-Headers` instead of hard-coding an
  allow-list (see `packages/server/src/main.ts`); a real backend would need to explicitly allow
  `traceparent` (and `tracestate`) or disable tracing propagation on the client.
- **No worked example for what schema to pair with any of the three non-default codecs.** The
  README's "Body codecs" table names `ResponseBody.text`/`.uint8Array`/`.formData`/`.none` and
  `RequestBody.text`/`.uint8Array`/`.urlParams`/`.formData`, but every worked example in the README
  uses the JSON default. Each pairing had to be worked out independently, by the same
  reverse-engineering approach each time (reading the codec's `Input`/decode-output type in
  `dist/request.d.ts` and finding — or writing, for `AtomFeedFromString`/`AdminStatsFromBytes` — a
  schema whose `Type`/`Encoded` matches it):
  - `ResponseBody.none` (`codec.name extends "none"` requires `undefined extends
    Schema.Schema.Encoded<S>`) → `Schema.Void` satisfies it.
  - `RequestBody.formData` (`Input: FormData`) → `Schema.instanceOf(FormData)`.
  - `ResponseBody.uint8Array` (decode output `Uint8Array`) → `Schema.Uint8ArrayFromSelf` for a
    passthrough, or a custom `Schema.transformOrFail` (`AdminStatsFromBytes`) when the bytes need
    further parsing.
  - `ResponseBody.text` (decode output `string`) → any string-based schema; a
    `Schema.transformOrFail` (`AtomFeedFromString`) for a non-JSON textual format, exactly as the
    README's prose suggests without an example.

  One worked example per codec in the README — even just the schema signature, not a full endpoint
  — would have turned four separate rounds of type-reading into zero.
- **No worked example of a *reusable* cross-endpoint setter.** Every README example chains setters
  inline at one call site. Writing `withAuth` (used above as a "worked well" point) required
  independently figuring out that the trick is to type the helper structurally
  (`<Plan extends { setHeader: ... }>`) rather than against a concrete `RequestPlan<Body, Rules,
  BodyReady>`, since that triple differs per endpoint. It works well once you know it; nothing in
  the docs points at the pattern.
- **We did not exercise, and so cannot vouch for or against:** retries (`setRetry`/`setRetries`),
  request gates (`makeRequestGate`), `RequestBody.text`/`.urlParams` specifically (we hit
  `.formData` but not these two), header-precedence tie-breaking beyond the single matcher above, or
  `UnhandledResponse.discard`/`"retain"` body ownership. Nothing in this project needed a retry, a
  second HTTP provider, or an endpoint whose response shape genuinely varies by header at runtime.
  The library's own
  [`docs/report.md`](../repo/docs/report.md) already flags several of these areas (retry/timeout
  interaction, mutable-input aliasing, dot-segment path values) as deferred findings from its
  pre-beta review — we have nothing to add or contradict there, since our path parameters
  (`Slug`, `Username`, UUIDs) are all schema-constrained to alphabets that cannot produce a bare
  `.`/`..` segment in the first place, which happens to sidestep that particular finding by
  construction rather than by deliberate mitigation.
- **Nothing else failed outright.** Every endpoint, every setter used, and the whole
  `pnpm pack` → `file:` dependency distribution flow worked exactly as documented once the CORS
  header issue above was understood and fixed on the server side (which is our code, not the
  library's). There is no unresolved blocker to report.

### On the browser-verification gap in the library's own review

[`docs/report.md`](../repo/docs/report.md) (the library's pre-beta review) explicitly lists
*"Browser, alternative-runtime, and official non-Fetch client coverage is absent"* as an open item.
This project's manual verification passes — a real, system-installed Chromium driven through
`playwright-core` against a live Vite dev server and Node backend, covering registration, login,
post CRUD across all three visibility levels, comments from both registered and anonymous authors,
a real multipart file upload rendered back as an inline image preview, the Atom feed, and
admin-only access control — are exactly that missing coverage, for at least one realistic app
shape using most of the library's codec surface. It is also precisely how the `traceparent`/CORS
gap above was found: it never surfaces in a same-origin `curl` smoke test or in Node-to-Node
integration tests, only in an actual cross-origin browser request.

## Effect Schema, separately from the HTTP library

Arbitrary/Pretty/Equivalence annotations, `Schema.TaggedError`, `Schema.Class`, `Schema.DateTimeUtc`,
and `Schema.optionalWith` are core Effect Schema features, not something `viell-effect-schema-http`
adds — the HTTP library's contribution is *consuming* those schemas for request/response
encoding and decoding. Both halves earned their keep in this project: nothing about Effect Schema
itself caused friction; every annotation and combinator used worked exactly as its own TSDoc
describes.
