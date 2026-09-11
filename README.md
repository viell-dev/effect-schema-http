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
(every non-JSON codec the library ships, a deliberately flaky endpoint, a response nobody
modelled, and an intentionally non-standard `205` status), and the admin user directory exists
specifically to exercise `makeRequestGate` — a filter-as-you-type datatable, the shape the
library's own docs use as the gate's motivating example.

The blog itself is scaffolding. What is being modelled is an API that has been running for years:
see [Why the API is like this](#why-the-api-is-like-this) for the full list of deliberate
misbehaviour and what each one cost the client.

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
            edgeCache.ts emulates the reverse proxy that fronts the feed in production.
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

| Feature | Endpoint(s) | Library surface it exercises |
| --- | --- | --- |
| Post attachments (upload) | `POST /api/posts/:slug/attachments` | `RequestBody.formData` |
| Post attachments (download) | `GET /api/posts/:slug/attachments/:id` | `ResponseBody.uint8Array` (raw file bytes) |
| Attachment bundle | `GET /api/posts/:slug/attachments/:id/bundle` | `ResponseBody.formData` (metadata + bytes in one multipart response) |
| Per-blog Atom feed | `GET /api/blogs/:username/feed.atom` | `ResponseBody.text` (XML) |
| Atom import | `POST /api/blogs/:username/import.atom` | `RequestBody.text` — the *same* schema, encoding instead of decoding |
| Legacy form login | `POST /api/users/login/legacy` | `RequestBody.urlParams` |
| Post export | `GET /api/posts/:slug/export` | two `200` rules separated by a `content-type` matcher, plus a status-predicate rule |
| Admin stats | `GET /api/admin/stats` | `ResponseBody.uint8Array` (bytes that are secretly JSON) |
| Admin cache refresh | `POST /api/admin/cache/refresh` | `ResponseBody.none`, status `205` not `204` |
| Admin search reindex | `POST /api/admin/search/reindex` | `retry` — the route answers `503` + `Retry-After` until it warms up — and an echoed attempt field contrasting that with a client-driven loop |
| Admin diagnostics | `GET /api/admin/diagnostics` | `UnhandledResponse` with `unhandledResponseBody: "retain"` |
| Admin user directory | `GET /api/admin/users` | plain JSON, driven through `makeRequestGate`, with computed query params that omit empty filters |
| Vendor search | `GET /api/search` | header pagination, scalar-or-array fields, stringly-typed values, `429`, and `200` with an empty body |
| The v1 comment endpoint | `POST /api/v1/comments` | always `200` with the outcome in the body — a `Schema.Union` used for a bad reason |
| Worker calendar | `GET /api/calendar`, `GET /api/calendar/:entryId` | a `_tag`-discriminated `Schema.Union` of three legitimate shapes, matched exhaustively |
| Authentication | every endpoint except the three public ones | a computed `authorization` header declared once on the API, removed by `extendApi` for login/register |
| Edge cache bypass | `GET /api/posts`, `GET /api/blogs/:username/feed.atom` | `setCache` plus a computed cache-buster, applied per call site through a `RequestPlanTransform` |
| Conflicting edits | `PUT /api/posts/:slug` | a mapped `409` opens a dialog, then replays the **same retained plan** through a `RequestPlanTransform` |

Building the conflict check also produced the only genuine bug this project has found in its own
code, and it is worth recording because the test suite is what caught it. The concurrency token was
originally the post's `updatedAt`, which read naturally and passed every test — until it didn't:
two writes landing inside the same millisecond share a timestamp, so a stale editor's save matched
the check and silently overwrote the other edit. The failure surfaced as an intermittent 200 where
a 409 was expected. `Post` now carries a `revision` counter instead, which cannot collide, and
`routes.test.ts` pins the same-millisecond case that exposed it.

The blog/post/comment CRUD underneath all of this is plain JSON in, JSON out — the default codec
the library needs no configuration for at all.

The bottom half of that table was added after the first pass of this evaluation, specifically to
cover the library surface the first pass had reported it *could not vouch for*: retries, the text
and url-encoded request codecs, response-rule precedence with more than one candidate, form-data
responses, and retained unmapped bodies. Every one of them is driven from the UI, not only from a
test.

## Why the API is like this

The blog was only ever a starting point — something with enough CRUD to hang an API off. The
point of the project is the API's *misbehaviour*, because that is what a client library actually
has to survive. An API designed the way a blog post would design it exercises nothing: JSON in,
JSON out, correct status codes, consistent casing. Real APIs are not like that. They accrete,
they get bolted onto by people in a hurry, they carry endpoints nobody dares change because
something nobody can identify still calls them, and they integrate vendors whose conventions
nothing else shares.

So every oddity below is deliberate, and each is something that exists in production systems right
now. The interesting column is the last one: what the client had to do about it.

| The oddity | Where | What a tidy API would have done | What the client needed |
| --- | --- | --- | --- |
| Every response is `200`, outcome in a body field | `POST /api/v1/comments` | status codes | a `Schema.Union` body — the intended mechanism, used for a bad reason |
| A request that must differ per retry attempt | `POST /api/admin/search/reindex` | request ids, or nothing | **the one genuine limitation** — see below |
| No results is `200` with an empty body, not `[]` | `GET /api/search` | `[]` | a second rule matched on `content-length: 0` with `ResponseBody.none` |
| `tags` is a string for one, an array for several | `GET /api/search` | always an array | `Schema.Union` normalised to an array |
| Numbers and booleans serialized as strings | `GET /api/search` | real JSON types | `Schema.NumberFromString`, a `"1"`/`"0"` transform |
| Pagination in response headers, body is a bare array | `GET /api/search` | an envelope | reading `envelope.headers` through a schema |
| Timestamps as epoch **seconds** | `POST /api/v1/comments` | ISO 8601 | one transform, defined once |
| `snake_case` fields | v1 comments, legacy login, search | consistent casing | schema field names; nothing propagates inward |
| A form-encoded request body | `POST /api/users/login/legacy` | JSON | `RequestBody.urlParams` |
| An XML request body | `POST /api/blogs/:username/import.atom` | JSON | `RequestBody.text` + the feed's own transform |
| Bytes that are secretly JSON, sent as `octet-stream` | `GET /api/admin/stats` | JSON with a correct content-type | `ResponseBody.uint8Array` + a transform |
| `205` where `204` was meant | `POST /api/admin/cache/refresh` | `204` | nothing — status is just a number |
| An error shape nobody ever modelled | `GET /api/admin/diagnostics` | the shared error envelope | `UnhandledResponse` with `"retain"` |
| A cache that ignores `Cache-Control` | the feed and Atom feeds | honour request directives | a cache-busting parameter alongside `setCache` |
| A concurrency token in a bespoke header | `PUT /api/posts/:slug` | `ETag` / `If-Match` | an ordinary `setHeader` |
| A burst limit answering `429` | `GET /api/search` | the same, honestly | nothing — `429` is already transient |
| Two representations at one status | `GET /api/posts/:slug/export` | separate endpoints, or honest ones | two rules separated by a `content-type` matcher |

One idea got as far as being designed and then thrown out, which is worth recording because it
looks plausible until you check: an endpoint using a URL **fragment** to select a representation,
`/api/users/:id#thin`. It cannot work. A fragment is not part of the request target and no HTTP
client transmits one, so the server would never see it — a server-backed test in the library now
pins exactly that (`tests/urlFragments.test.ts`). The only correct use of a fragment is the one
this project already makes of it: client-side routing, which is why every link in the Atom feed
points at `#/posts/<slug>`. A representation selector has to be a query parameter or a header,
which is what `GET /api/posts/:slug/export` uses.

**Exactly one of those needed something the library could not be configured to do.** An earlier
draft of this document claimed two, and the first was a misreading worth correcting in place,
because it is the kind of mistake a consumer makes on first contact with the response model:

1. **A body-shaped union is the design, not a shortfall.** Rules match status and headers, never
   the body, and that is deliberate — selection happens before the body is read, so a rule is
   chosen without consuming a one-shot stream and nothing is buffered merely to decide how to
   decode it. A response whose payload varies while its envelope does not is therefore a *schema*
   question, and `Schema.Union` is the intended answer. The `200`-with-an-`error`-field endpoint
   needs that mechanism for a bad reason, but the mechanism itself is not a workaround, and the
   two layers compose rather than compete: `Match.tag` over the envelope asks what kind of
   response arrived, `Match.tag` over `body` asks what kind of value it carries, each exhaustive.
   The genuine cost is narrower than "a limitation": that one endpoint's failures cannot be
   rendered by the same function as everyone else's, because it never sends a shared error shape.

   The calendar (`GET /api/calendar`) exists in this project to make the point standing on its own
   feet. It is a correct, modern endpoint, and it still answers with a mixed list of three shapes
   — events, repeating events, and assignments projected from service orders — because a worker's
   calendar genuinely contains three different things. Flattening them into one struct with
   `recurrence?`, `customer?` and `address?` all optional would be strictly worse: the compiler
   would no longer know that an assignment always has an address and an event never does.

2. **A request cannot vary per retry attempt.** Encoding runs once before the retry loop and every
   attempt replays it — correct, since a credential must not change mid-retry — so an echoed,
   incrementing attempt counter needs `setRetries(0)` and a loop over the plan instead, giving up
   `Retry-After` handling and the jittered schedule to get it. This one is a real trade, and the
   library's design notes now track it as an open question rather than settled behaviour.

Everything else on that list is a declaration or a schema. That is the actual finding of this
project: the library's failure mode under a badly-behaved API is *more configuration*, not
workarounds — and the single place it genuinely cannot help is a documented trade, not an
oversight.

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

The in-memory store answers in well under a millisecond, which makes request supersession
impossible to watch: two keystrokes typed milliseconds apart never overlap on the wire, so nothing
is ever there to cancel. `RESPONSE_DELAY_MS=400 pnpm --filter @realworld/server run dev` delays one
route (`RESPONSE_DELAY_PATH`, default `/api/admin/users`) so the users directory's gate behaviour
is reproducible in a browser — see "Request gates" below.

The feed and the Atom feeds are served through an emulated reverse proxy with a ten-second TTL
(`packages/server/src/edgeCache.ts`); responses carry `X-Cache` and `Age`, and the feed pages
display both. `EDGE_CACHE_TTL_MS=0` disables it.

Tests: `pnpm --filter @realworld/domain run test` (37 tests) and
`pnpm --filter @realworld/server run test` (35 tests) run under Vitest. The web package has no
automated tests; it was verified by driving a real, system-installed Chromium through
`playwright-core` against both dev servers, in three passes: (1) register → post → comment signed
in → sign out → comment anonymously → create a private post → confirm it 404s for a signed-out
visitor instead of leaking that it exists; (2) first-registered-user-becomes-admin → upload a real
PNG attachment and see it render as an inline preview → view the same post through its Atom feed →
refresh the admin cache and watch the reason field clear itself on the `205` response → confirm a
second user gets neither the admin nav link nor access to `/admin`; (3) a delayed
`/api/admin/users` route plus rapid, genuinely distinct keystrokes into the users-directory filter,
confirming real `net::ERR_ABORTED` network failures for every superseded request, and — after the
library grew `gate.cancel` — that correcting a typo inside the previous request's flight resolves
from the gate's retained rows with no network request at all (see "Request gates" below). No
browser-automation tool was preinstalled in this environment, so that was set up ad hoc for these
verification passes; it is not part of the committed project.

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
- **A schema whose *encoded* type is the codec's input, with no transformation**: `LegacyLoginForm`
  (`legacy.ts`) is an ordinary `Schema.Struct` of branded strings plus a `grant_type` literal, and
  its encoded form — a flat record of strings — already satisfies `RequestBody.urlParams`'s
  "record of coercible values". The same idea as the identity schemas above, one step less
  obvious: nothing was written *for* the codec, the existing shape simply already fits.
- **The same transformation used in both directions across the wire**: `AtomFeedFromString` is
  encoded by the client for the import endpoint and decoded by the server, then decoded by the
  client for the feed endpoint and encoded by the server — four uses, one definition, and a
  malformed document is rejected identically at either end. `PostExportFromMarkdown` (`export.ts`)
  does the same for a Markdown document with YAML-ish front matter, where the *body* may itself
  contain the `---` delimiter (covered by `export.test.ts`).
- **Extending a schema by reusing its `.fields`**: `CurrentUser` (`user.ts`) is
  `Schema.Struct({ ...Profile.fields, role: AdminRole })` — a real reuse of `Profile`'s field
  definitions for the one extra fact only the authenticated user can see about themselves, not a
  hand-copied duplicate that could drift.

## Request gates: a filter-as-you-type datatable

`makeRequestGate` was the one exported API this project hadn't touched. Its own README example is
literally a paginated/searchable user table, so the admin panel's "Users" section
(`packages/web/src/usersGate.ts` + `components/usersDirectory.ts`) is that example, built for real:
two text inputs (name, email) over `GET /api/admin/users`, firing a new request on every `input`
event — deliberately no debounce, so the library's own concurrency handling is what has to carry
the load of several genuinely distinct filter values submitted within milliseconds of each other.

Reading `docs/design.md`'s "Request gates" section closely before writing any code mattered here,
because the obvious first guess about what a "gate" gives you for free is wrong. The docs say:
*"Different keys may run concurrently, but older completions cannot overwrite newer successful
completions."* That is a **correctness** guarantee — a slow, stale response can't clobber a newer
one in the gate's single retained slot — not a **cancellation** one. Calling plain `gate.run(input)`
on every keystroke does *not* abort the previous keystroke's in-flight `fetch()`; it just makes sure
that request's result, if it arrives late, can't overwrite whatever a newer request already
produced. For a live filter box that still leaves every stale request running to completion on the
wire, which is exactly what this task asked to avoid.

The first version of this page used `gate.invalidate` — *"clears the retained pair, interrupts every
request currently owned by that gate"* — because it was the only interruption tool the gate offered,
and it reported the obvious cost as a gap: there was no way to interrupt the current flight while
keeping what the gate had already cached, so the gate's headline reuse behaviour was wiped before it
could ever help. **The library has since closed that gap with `gate.cancel`**, which performs the
same interruption and stale-write prevention while retaining the cached pair. `usersDirectory.ts`
now calls `gate.cancel` before every `gate.run`, and `FetchHttpClient` — per the library's own
"Providers and cancellation" section — translates that Effect interruption into a real
`AbortController.abort()` on the underlying `fetch()`.

Both halves were verified concretely, not inferred from the docs: driving the page through a real
(system-installed) Chromium against the server's `RESPONSE_DELAY_MS=400` route. Typing `a`, `d`, `a`
back-to-back produced this exact request log:

```
sent      /api/admin/users?name=a
sent      /api/admin/users?name=ad
failed    /api/admin/users?name=a    net::ERR_ABORTED
sent      /api/admin/users?name=ada
failed    /api/admin/users?name=ad   net::ERR_ABORTED
finished  /api/admin/users?name=ada
```

Real, browser-level aborted network requests, and only the last keystroke's request completed and
rendered. Then the case `cancel` exists for — typing a typo and correcting it *inside* the typo's
own request flight, the single most ordinary thing that happens in a search box:

```
sent      /api/admin/users?name=adax
failed    /api/admin/users?name=adax  net::ERR_ABORTED
(correcting back to "ada": no network request at all)
```

The correction resolved straight out of the gate's retained success, with the "Loading…" line never
appearing, because the cancelled `adax` flight could neither complete nor evict what `ada` had
already put there. Under the old `invalidate` call that same correction cost a full round trip.
That is the concrete evidence behind the bullets below.

The page also keeps a **Refresh** button wired to `gate.refresh`, the cache-bypassing counterpart:
same filters, but always a new execution. Between `run`, `refresh`, and `cancel`, the only gate
operation this page has no natural use for is `reload`, which re-runs the retained *input* rather
than the currently typed one.

**What remains a judgement call, not a defect:** cancellation is whole-gate, so a page running
several keys concurrently behind one gate cannot supersede just one of them, and retention is still
a single entry, so alternating between two filters never hits the cache. Both are recorded as open
questions in the library's design notes (10 and 11); neither bites this page, which runs one key at
a time.

## Using `viell-effect-schema-http`: what worked well

- **The core API is exactly as pleasant as the README promises.** `createApi(baseUrl, { responses
  })` plus `api.createRequest({ method, path, body, responses })` produces a fully-typed, callable,
  pipeable endpoint. Every one of the twenty endpoints in `packages/web/src/api.ts` was declared
  this way — across five different response/request codecs — and it stayed easy to read even with
  five shared error rules inherited by every one of them.
- **The two discrimination layers compose, and knowing which is which is the whole trick.**
  Response rules discriminate the *envelope* on status and headers; schemas discriminate the
  *body*. This project needed both, sometimes on the same call: the v1 comment endpoint is matched
  first on its envelope tag and then on the body's `status` field, and the calendar is one envelope
  tag wrapping a three-member union matched exhaustively. Getting this backwards — expecting a rule
  to inspect a payload — is the first-contact mistake, and the docs now say plainly why rules
  cannot: selection happens before the body is read, so a rule is chosen without consuming a
  one-shot stream.
- **Response unions as ordinary success values pay off most when a status is a *question*, not a
  failure.** The conflict flow is the case that made this concrete. A `409` from `PUT
  /api/posts/:slug` is not an error condition to be caught and re-parsed — it is a typed value
  carrying the server's explanation, sitting in the same union as the success, which the editor
  reads and puts straight into a dialog. `if (result._tag === "ConflictError")` narrows the body
  for free, and the code that follows reads like the product requirement it implements. With a
  throwing client this is a catch block that has to re-derive the status, re-parse the payload, and
  then re-enter the happy path from outside it.
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
- **Immutable setters compose into small, genuinely reusable combinators.** This project's first
  worked example was `withAuth`, a helper attaching the bearer token at every authenticated call
  site, and it went through all three stages the library did: a guess at a minimal structural type
  (`{ setHeader }`) because the library had no public name for a cross-endpoint setter; then the
  exported `RequestPlanTransform`; then deleted outright, because computed header values turned
  authentication into an API-wide default (see the next section). That is the honest outcome —
  auth was never a good fit for an opt-in, because the safe answer is "attached unless a
  declaration says otherwise".

  `forceFresh` (`packages/web/src/forceFresh.ts`) is what the pattern actually looks like when it
  fits. Bypassing the caches in front of the feed needs two setters that must travel together —
  `setCache({ control: "no-cache", fetch: "reload" })` for the browser's own HTTP cache, and a
  computed cache-busting query parameter for the reverse proxy, which is old enough to ignore
  request cache directives entirely — and if either is forgotten the refresh silently does
  nothing. It applies to two endpoints whose response shapes have nothing in common (`listFeed`
  decodes JSON, `getBlogFeed` decodes XML through `ResponseBody.text`), which is exactly the case
  `RequestPlanTransform` exists for. And it is genuinely a *call-site* decision: normal navigation
  should hit the caches, because that is what they are for; only a reader explicitly asking for a
  refresh has any business going around them.

  `forceUpdate` (`packages/web/src/forceUpdate.ts`) is the sharpest version of the same idea, and
  the one that best shows why plans being *cold and re-executable* matters. Saving a post sends the
  revision the editor loaded; if someone else saved first the write is refused, a dialog asks the
  obvious question, and if the person chooses to overwrite, the **same plan** is executed again
  with one transform applied — adding the override and dropping the revision the caller has
  knowingly abandoned. Nothing is rebuilt, nothing is re-encoded, and there is no second copy of
  the call site to keep in sync. Here the opt-in is not even a call-site decision made in advance:
  it is a decision made by a human, after the first attempt has already failed.

  The three together are the clearest statement this project can make about the library's defaults
  model: **if the safe answer is "always", it belongs in the API declaration as a computed value;
  if the caller has to choose, it belongs in a `RequestPlanTransform`.** Both are one-liners at the
  point of use, and getting the distinction wrong is what produced `withAuth`.
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
- **Effect interruption really does become a real `fetch()` abort, end to end.** `gate.invalidate`
  → Effect fiber interruption → `FetchHttpClient`'s abort-signal translation → an actual
  `net::ERR_ABORTED` in Chromium's network log, confirmed by driving a real browser (see the
  "Request gates" section above). This is exactly what the README's "Providers and cancellation"
  section promises, and it held up under an artificially-delayed, rapid-fire, real-network test.

## Using `viell-effect-schema-http`: friction, gaps, and one real bug we hit

- **`FetchHttpClient` sends tracing headers on every request, and the library's docs did not
  mention it.** _Resolved in the library._ This broke every cross-origin call from the browser
  during manual verification: a CORS server with a fixed `Access-Control-Allow-Headers` allow-list
  (a completely standard pattern — see the *first* version of `packages/server/src/main.ts` in git
  history) rejects the preflight, and the failure surfaces only as an opaque
  `RequestError: Transport error (...)` with no indication that CORS, let alone a specific header,
  was the cause. Diagnosing it required opening the browser console for the real
  (non-Effect-wrapped) message and instrumenting a raw `fetch()` call to compare. This is
  technically `@effect/platform`'s tracing propagation rather than code in this library, but it is
  exactly the kind of thing a consumer hits *only* because of how this library uses
  `HttpClient.HttpClient`. The library's README now has a "Browsers and CORS" section that names
  the headers, explains the preflight consequence, and gives the
  `HttpClient.withTracerPropagation(false)` opt-out — and a library test pins the header names so
  the guidance cannot drift from the provider. Worth knowing: it is **two** headers, `traceparent`
  *and* `b3`, so an allow-list fixed up to permit only the one named in the original report would
  still have failed. **Fix applied on our side:** the demo server reflects
  `Access-Control-Request-Headers` instead of hard-coding an allow-list (see
  `packages/server/src/main.ts`).
- **No worked example for what schema to pair with any of the three non-default codecs.**
  _Resolved in the library._ Both codec tables in the README now carry the schema each codec pairs
  with, in both directions, and `examples/bodyCodecs.ts` is a typechecked endpoint per codec. The
  four pairings worked out below are the ones it documents. The original complaint follows as
  written, because it is the reason the fix exists. The
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
  — would have turned four separate rounds of type-reading into zero. That is exactly what was
  added.
- **No worked example of a *reusable* cross-endpoint setter.** _Resolved in the library._ Every
  README example chained setters inline at one call site. Writing `withAuth` required independently
  figuring out that the helper had to be typed structurally (`<Plan extends { setHeader: ... }>`)
  rather than against a concrete `RequestPlan<Body, Rules, BodyReady>`, since that triple differs
  per endpoint. The library turned out to have exactly that signature internally, used by all of
  its own pipeable setters, and it is now exported as `RequestPlanTransform` with the pattern
  documented under "Reusable cross-endpoint setters".
- **A default header could not depend on state that did not exist yet.** _Resolved in the library._
  The deeper reason `withAuth` existed at all: `createApi` is evaluated once when the module loads,
  and an API-wide `authorization` header was a plain string captured at that moment — which, in a
  browser app, is always "signed out". The only dynamic seam was `transformRequest`, and a
  transform runs *after* the declarative layer is materialized, so nothing below it can take it
  away: an endpoint's `removeHeaders: ["authorization"]` against a transform-supplied header is
  silently ignored. That left attaching auth per call site as the only option that was both
  dynamic and removable.

  The library now accepts a **computed value** for any header or query parameter —
  `() => value | undefined`, called once per request while it is materialized, where `undefined`
  omits the field. Because it is still an ordinary *declared* header, it composes: this project's
  API attaches `authorization` for everything, a `publicApi = api.pipe(extendApi({ removeHeaders:
  ["authorization"] }))` carries the three endpoints that must not send a credential, and the
  header is never even computed for those. `withAuth` is gone, and the twenty-odd call sites that
  used to wrap their plan in it are now plain calls.

  This is a better shape for a reason beyond tidiness: it fails safe. A new endpoint is
  authenticated by construction, so forgetting to think about auth cannot produce an
  unauthenticated request — whereas the old pattern failed the other way, silently, if you forgot
  `withAuth`. The inverse risk (a credential going somewhere it should not) is confined to an
  explicit opt-out list, and would not exist at all for an API whose identity provider lives on a
  separate origin. The same mechanism removed two other papercuts: an empty filter box and an
  unchecked toggle now omit their query parameters instead of sending `name=` and `degraded=0`.
- **Everything the first pass could not vouch for has since been exercised, and all of it worked.**
  That list was retries, `RequestBody.text`/`.urlParams`, header-precedence tie-breaking beyond a
  single matcher, and `UnhandledResponse.discard`/`"retain"` body ownership — every one of them
  skipped because nothing in the blog happened to need it, not because anything was wrong. Rather
  than write tests against features the app did not use, the app grew features that genuinely need
  them (see the feature table above), and each was then driven through a real browser:
  - **Retries.** `retry: { times: 3 }` on the reindex endpoint. The server answers `503` with
    `Retry-After: 1` for its first two calls; Chromium's network log shows `503`, `503`, `202`
    while the page's handler only ever sees the `202`. No custom `while` predicate was needed —
    `503` is already in the library's transient classification — and the intermediate bodies are
    drained by the library rather than surfacing anywhere. The one thing worth saying out loud:
    `Retry-After` is only *readable* cross-origin if the server lists it in
    `Access-Control-Expose-Headers`, which is the server's job, not the library's.

    The reindex endpoint also echoes back whatever `x-attempt` field the caller sends — the server
    does nothing else with it — which turned out to be the sharpest way to see what the built-in
    retry actually does. Because the request is encoded once before the retry loop, all three
    attempts carry the *same* `x-attempt`, so the echo cannot distinguish them:

    ```
    -> POST x-attempt=1    <- 503 echo=1
    -> POST x-attempt=1    <- 503 echo=1
    -> POST x-attempt=1    <- 202 echo=1
    ```

    That is correct — a credential must not change mid-retry, and the same rule governs computed
    header values and `mapRequest`, all of which resolve once per evaluation — but it means **a
    request that genuinely has to differ per attempt cannot use the built-in policy at all.** The
    alternative is `setRetries(0)` plus a loop over the plan, which works cleanly because plans are
    cold and re-executable:

    ```
    -> POST x-attempt=1    <- 503 echo=1
    -> POST x-attempt=2    <- 503 echo=2
    -> POST x-attempt=3    <- 202 echo=3
    ```

    The admin panel runs both, side by side, with the attempt trail visible
    (`packages/web/src/components/reindexPanel.ts`). The trade is explicit and worth stating: the
    first form is one line and brings `Retry-After` handling and jittered backoff with it; the
    second gives all of that up in exchange for varying the request per attempt. The library's
    design notes now record this case under its deferred retry-lifecycle question.
  - **`RequestBody.text` and `.urlParams`.** The Atom importer encodes a domain value into XML
    through the same `AtomFeedFromString` the feed endpoint decodes with, and the legacy login
    posts `LegacyLoginForm` as `application/x-www-form-urlencoded`. Both pairings are the ones the
    library's README now documents, and both worked from the type signature alone.
  - **Header precedence.** The export endpoint declares two rules at `200` separated only by a
    `content-type` matcher, plus a third matching any 5xx through a status *predicate*. The
    documented ranking held: the header-bearing rules are tried first and the predicate rule never
    shadows them, so the same call site renders parsed JSON or a parsed Markdown document
    depending only on the `Accept` it sent.
  - **Retained unmapped bodies.** Diagnostics maps the modern subsystem's JSON and nothing else;
    the old watchdog's `text/plain` `503` arrives as an `UnhandledResponse` whose body the library
    hands over instead of draining. Reading `error.response.text` renders the dump; the failure
    path runs `error.discard`. The ownership rule is exactly as documented, and the *default*
    (drain) is clearly the right one — opting out is a deliberate diagnostic act.

  The library's own
  [`docs/report.md`](../repo/docs/report.md) already flags several of these areas (retry/timeout
  interaction, mutable-input aliasing, dot-segment path values) as deferred findings from its
  pre-beta review — we have nothing to add or contradict there, since our path parameters
  (`Slug`, `Username`, UUIDs) are all schema-constrained to alphabets that cannot produce a bare
  `.`/`..` segment in the first place, which happens to sidestep that particular finding by
  construction rather than by deliberate mitigation.
- **A union of two plan types is not pipeable, only its Effects are.** The login page chooses
  between the JSON and url-encoded endpoints at runtime, and `plan.pipe(toEffect)` on the resulting
  union does not typecheck: the two plans differ in their `Body` type parameter, so neither concrete
  `pipe` signature accepts the union. Extracting `.effect` inside each branch and unioning *those*
  works fine, because both endpoints declare the same responses and therefore produce the same
  Effect type. This is ordinary TypeScript variance rather than a library defect, and the fix is
  two lines, but it is the one place where the plan's rich type parameters got in the way instead
  of helping.
- **Nothing else failed outright.** Every endpoint, every setter used, and the whole
  `pnpm pack` → `file:` dependency distribution flow worked exactly as documented once the CORS
  header issue above was understood and fixed on the server side (which is our code, not the
  library's). There is no unresolved blocker to report.

### On the browser-verification gap in the library's own review

[`docs/report.md`](../repo/docs/report.md) (the library's pre-beta review) explicitly lists
*"Browser, alternative-runtime, and official non-Fetch client coverage is absent"* as an open item.
This project's manual verification passes — a real, system-installed Chromium driven through
`playwright-core` against a live Vite dev server and Node backend, covering registration, login
through both the JSON and url-encoded endpoints, post CRUD across all three visibility levels,
two tabs racing on one post through the conflict dialog, comments from both registered and
anonymous authors, a real multipart file upload rendered back as an inline image preview and
re-fetched as a multipart bundle, the Atom feed in both directions, content-negotiated exports,
retries against a genuinely flaky route, a retained unmapped response body, request-gate
supersession and cache reuse, and admin-only access control — are exactly that
missing coverage, for at least one realistic app shape using every codec the library ships. It is
also precisely how the `traceparent`/CORS
gap above was found: it never surfaces in a same-origin `curl` smoke test or in Node-to-Node
integration tests, only in an actual cross-origin browser request.

## Effect Schema, separately from the HTTP library

Arbitrary/Pretty/Equivalence annotations, `Schema.TaggedError`, `Schema.Class`, `Schema.DateTimeUtc`,
and `Schema.optionalWith` are core Effect Schema features, not something `viell-effect-schema-http`
adds — the HTTP library's contribution is *consuming* those schemas for request/response
encoding and decoding. Both halves earned their keep in this project: nothing about Effect Schema
itself caused friction; every annotation and combinator used worked exactly as its own TSDoc
describes.
