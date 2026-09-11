# Design

The library defines an endpoint once, then creates immutable request plans at each call site. Endpoint functions take
only their required path values; endpoints without placeholders are zero-argument. A plan remains lazy while the caller
sets a body, query parameters, headers, execution policy, or response schemas; `.effect` is a getter that constructs a
fresh Effect only when read. Intermediate plans therefore allocate no discarded execution Effects, and a retained plan
can be read and executed again.

```ts
const api = createApi("https://api.example.com", {
  headers: { authorization: "Bearer ..." },
  retries: 0,
  responses: [response({ _tag: "not-found", status: 404 }, MyApiNotFound)],
});

const getUsers = api.createRequest({
  method: "GET",
  path: "/users",
  responses: [
    response({ _tag: "ok", status: 200 }, Schema.Array(User)),
    response({ _tag: "empty", status: 204 }, Schema.Void, { codec: ResponseBody.none }),
    response({ _tag: "gone", status: 410 }, Gone),
  ],
});

const users = getUsers().pipe(
  setUrlParam("fields", "id,name"),
  setResponseSchema({ _tag: "ok", status: 200 }, Schema.Array(ThinUser)),
  setCache({ control: "max-age=3600", fetch: "force-cache" }),
  setRetries(3),
  toEffect,
);
```

Colon-prefixed placeholders become the required properties of one endpoint argument object. Placeholder names start
with an ASCII letter or underscore and may then contain ASCII letters, digits, or underscores. Placeholders can occupy
a full segment or appear inside one, such as `/files/:name.:ext` or `/v:version/users`. Repeating a placeholder name in
one path reuses its single object property. Endpoints without placeholders remain zero-argument functions.

Each value must be a non-empty string and is encoded with `encodeURIComponent`. In particular, `/` in an opaque value
is allowed and sent as `%2F`; it does not create another path segment. A runtime check rejects missing or unexpected
properties, positional arguments, non-string values, and empty strings at degraded or untyped call sites:

```ts
const getUserPost = api.createRequest({
  method: "GET",
  path: "/users/:userId/posts/:postId",
  responses: [response({ _tag: "ok", status: 200 }, BlogPost)],
});

const request = getUserPost({ userId, postId });
```

Whole `.` and `..` segments are a current limitation: URL normalization can change the target path despite parameter
encoding. Validate that interpolation cannot produce such segments until the policy below is resolved; see
[the review report](report.md#1-dot-segment-path-values-can-change-the-target-path).

A backslash escapes a literal colon that would otherwise look like a placeholder. This keeps action-style paths usable:

```ts
path: "/users/:userId\\:archive"; // getUser({ userId }) sends /users/<encoded-id>:archive
```

A URL fragment is retained in the plan's URL string and query parameters are inserted before it, so a path declared as
`/users/:userId#thin` with an added parameter produces `/users/u-1?expand=profile#thin` rather than burying the query
inside the fragment. That placement is the only thing the library can usefully do with a fragment, because **no HTTP
client transmits one**: RFC 3986 keeps the fragment out of the request target, and a server-backed test confirms the
server receives `/users/u-1?expand=profile` with the fragment gone. An API therefore cannot give a fragment meaning —
a `#thin` convention selecting a thinner representation could never reach the endpoint meant to honour it, and a query
parameter or a header is the only workable spelling. A `#` appearing inside a path parameter or query value is
percent-encoded as `%23` and stays in the path or query, so a value containing one cannot truncate the URL. This is
unlike the dot-segment case, where encoding alone is not sufficient.

An API base URL is a literal prefix rather than a WHATWG URL-resolution base: `https://example.test/v1` plus `/users`
produces `https://example.test/v1/users`. An absolute endpoint path cannot be combined with a base URL and fails as a
configuration defect instead of producing a concatenated URL. Query parameters written in `path` are normalized into
the endpoint's query-parameter state, so endpoint options and plan setters can replace them without duplication.

Plans, endpoints, and APIs are pipeable. Plan combinators preserve body typestate and response unions, while
`mapEndpoint` turns an endpoint into another ordinary endpoint with the same path arguments:

```ts
const getThinUsers = getUsers.pipe(
  mapEndpoint((plan) =>
    plan.pipe(setUrlParam("fields", "id,name"), setResponseSchema({ _tag: "ok", status: 200 }, Schema.Array(ThinUser))),
  ),
);

yield * getThinUsers().effect; // sends once
yield * getThinUsers().effect; // sends again with the same composed overrides
```

Composition does not add execution or caching semantics: every plan remains immutable and every evaluation of its cold
Effect sends the request again.

Plan combinators that do not change typestate share one public signature, `RequestPlanTransform`. Every pipeable
setter returns it, and an application helper that must apply to more than one endpoint — attaching a bearer token,
a tenant header, a locale — is annotated with it rather than with a concrete `RequestPlan<Body, Rules, BodyReady>`
instantiation, which would fix the triple to a single endpoint. The type is deliberately limited to typestate-
preserving operations: `setBody`, `setRequestBodyCodec`, and `setResponseSchema` change the plan's type parameters and
therefore stay per-endpoint compositions through `mapEndpoint`.

The implementation uses `@effect/platform`'s `HttpClient` service. The Effect keeps the transport as an explicit
requirement. Applications provide `FetchHttpClient.layer`, a Node client layer, or a test client. Accessing `.effect`
does not choose a runtime or start a Promise.

## Response model

A mapped response is a normal success value regardless of its status. A `404`, `410`, or `503` only enters the Effect
error channel when no response rule handles it. Transport failures, request encoding failures, and response decoding
failures remain errors.

Each mapped response produces an envelope:

```ts
type ResponseEnvelope = {
  readonly _tag: "ok";
  readonly status: 200;
  readonly headers: Headers;
  readonly headerEntries: ReadonlyArray<readonly [string, string]>;
  readonly cookies: Cookies;
  readonly body: ReadonlyArray<User>;
  readonly matched: { readonly _tag: "ok"; readonly status: 200 };
};
```

The actual type is a discriminated union over all response rules. Each declaration enforces unique tags at both the
type and runtime levels, so checking `response._tag` narrows both the envelope and its body without custom guards, even
when several rules share a status. The tag also makes the union work directly with Effect's `Match.tag`:

```ts
const description = Match.value(result).pipe(
  Match.tag("ok", ({ body }) => body.name),
  Match.tag("not-found", ({ body }) => body.message),
  Match.tag("gone", ({ body }) => body.deletedAt),
  Match.exhaustive,
);
```

`matched` preserves the complete selected matcher, and exact matcher headers are reflected in the normalized `headers`
type. `headerEntries` preserves independently repeated field values when the provider supplies them, while `cookies`
retains Effect's separately parsed `Set-Cookie` representation. A mapped envelope does not retain the original
`HttpClientResponse`: its body has already been consumed and the response would not be safely replayable from a request
gate. `_tag`, `status`, and `matched` are deliberately redundant: `_tag` is the Effect-compatible discriminant,
`status` is the actual status (and remains a literal for exact status matchers), and `matched` explains why the rule was
selected. Effect's `Match` is useful for consuming the result but not for defining the response table: its runtime
cases erase the schema and context information the request factory needs to retain in its generics.

`UnhandledResponse` retains the original `HttpClientResponse` rather than copying only status and headers. Its body is
drained before the error is emitted by default, releasing the transport resource without buffering the complete body.
API and endpoint options can select `unhandledResponseBody: "retain"`; the plan-level
`setUnhandledResponseBody("retain")` form is useful for one diagnostic call. Ownership of that live body then transfers
to the caller, which must consume it or run `error.discard`. The discard Effect treats an absent body as already clean
and otherwise reports a response-stream failure to an explicit caller; automatic cleanup preserves the primary
`UnhandledResponse` if cleanup itself fails. `ResponseDecodeError` also retains response metadata and the schema cause,
although its body has already been consumed. Mapped `ResponseBody.none` responses are drained by the library.

Files and multipart responses are intentionally not invented as a field yet. They should be introduced through body
codecs so the envelope accurately describes whether `body`, `files`, or both exist for that response rule.

## Defaults and overrides

- API response rules are inherited by every endpoint. This supports APIs with a common `404`, authentication response,
  maintenance response, or other shared response shape.
- An endpoint response rule replaces an inherited rule with the same unique tag.
- `setResponseSchema` replaces the rule with the same tag in place for one request plan. Other response possibilities
  and tie-break positions stay intact. It may change both the matcher and schema. If the tag is new, the rule is added.
- Status and header matchers accept exact values or predicates. Exact strings remain convenient, while predicates
  support status ranges and values such as `application/json; charset=utf-8` without introducing schema failures during
  rule selection.
- Rules with more matched headers rank first. Among rules with the same number of matched headers, an exact status
  ranks above a status predicate. Declaration order breaks any remaining tie. A plan rule with a new tag is prepended,
  so it wins an equally specific tie at that call site.
- API options flow to endpoints and plans. Endpoint options override API defaults; plan setters override both.
- `api.extend(options)` and pipeable `extendApi(options)` create a sub-API with merged headers, query parameters,
  policies, transforms, and response rules. Its optional `baseUrl` replaces the complete inherited base URL; it is not
  a path-relative rewrite. APIs expose their base URL, and `setBaseUrl(...)` can redirect one plan to a mirror or
  alternate host.
- API extensions and endpoint definitions accept plural `removeHeaders` and `removeUrlParams` lists for deleting
  inherited declarative defaults. Removal happens before declarations at the same scope, so an extension or endpoint
  can intentionally re-add a removed name. A name-only query-parameter removal deletes every repeated value for that
  name.
  Plan combinators remain singular `removeHeader(name[, value])` and `removeUrlParam(name[, value])` operations. A
  declarative `{ name, value }` entry performs the same targeted removal. These declarative removals do not undo values
  introduced later by a request transform.

This replacement model keeps the common thin-object case precise: replacing the `200` schema removes the original
`200` body type, while inherited `404` and endpoint-specific `410` envelopes remain in the union.

Precise replacement inference requires tuples with literal response tags. Inline declarations preserve these types;
reusable lists should use `as const`. Ordinary arrays also work: composition and plan-level replacement retain a
conservative union of the original and incoming rules because their runtime membership is unknown to TypeScript.
Duplicate-tag validation still runs at runtime. Widened or union-valued tags inside tuples remain a type-inference
limitation; see the remaining questions and [review report](report.md).

Plan setters preserve earlier plans structurally, but do not deep-clone caller-owned bodies, response matchers, codecs,
or policy objects. API and endpoint configuration can also retain references to declaration inputs. Treat all such
inputs as immutable after passing them to the library. This is especially relevant when reusing an Effect or a gate.

## Bodies and request fields

The endpoint definition optionally declares a request body schema, but request bodies are never endpoint-function
arguments. Until `createUser().setBody(value)` supplies a value, the plan's `.effect` has the diagnostic
`RequestBodyRequired` type rather than an Effect. Reading the getter still constructs a failed Effect at runtime, so an
untyped caller that bypasses this check fails with `RequestBodyRequired` before the HTTP client is called.
The caller supplies the ordinary decoded TypeScript value—never a schema-wrapped value—and the library uses the
endpoint's schema to constrain and encode it. An optional or explicitly undefined body can be represented in the schema
and set as such.

A schema-typed `defaultBody` supports RPC-style endpoints with static payloads:

```ts
const doFoo = api.createRequest({
  method: "POST",
  path: "/foo",
  body: FooCommand,
  defaultBody: { action: "foo" },
  responses: [response({ _tag: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
});

const request = doFoo();
```

Such a plan is immediately executable, while `.setBody(...)` can still replace the static body at a call site.
An explicit `defaultBody: undefined` is treated as absent; use `.setBody(undefined)` when the schema accepts it.

GET and HEAD definitions reject body schemas, and execution checks again after raw request transforms. This follows the
Fetch transport's actual constraint instead of advertising a request shape that its default transport cannot execute.
Other methods are intentionally open strings rather than a REST-shaped union. Standard methods and extension methods
such as `PROPFIND` use the same request machinery; the selected transport remains responsible for rejecting invalid or
forbidden method tokens.

Request bodies also separate schema encoding from wire encoding. JSON is the default. `RequestBody.text(contentType)`,
`RequestBody.uint8Array(contentType)`, `RequestBody.urlParams`, and `RequestBody.formData` cover common Fetch body
shapes, while the exported codec interface permits another `HttpBody` representation. The codec's input type must match
the schema's encoded type, so the caller still passes the schema's ordinary TypeScript type to `.setBody(...)`.
`setRequestBodyCodec(...)` can replace the endpoint codec on one immutable plan. `mapRequest` remains the final escape
hatch for transport-specific bodies and request fields.

Both schema encoding and wire encoding are fallible. A schema may reject an ordinary value supplied to `.setBody(...)`
or fail while transforming it to its encoded representation. `RequestBodyEncodeError` retains the request constructed
so far and the original schema or HTTP-body cause. These failures occur when the plan Effect is evaluated, before the
HTTP client is called.

Response body handling uses codec values rather than a growing string union. `ResponseBody.json` is the default. It
strictly parses the response text as JSON: the token `null` decodes to JavaScript `null`, while a zero-length,
whitespace-only, or malformed payload fails with an `HttpClientError.ResponseError`. `ResponseBody.text` reads the body
as a string before schema decoding, so a schema can parse JSON itself or decode XML, YAML, or a domain-specific text
format. The default reader can be set at API, endpoint, or plan scope; an explicit response-rule codec takes precedence.
Custom codecs are accepted in every default scope, so an API-wide parser can produce ordinary or branded intermediate
objects for its endpoint schemas. Keeping parsing in a schema is equally supported: `ResponseBody.text` followed by a
composed `*FromString` schema is the same pipeline with the parsing boundary moved into Effect Schema.

Each codec names one concrete transport value, and the schema paired with it is the one whose decode input (responses)
or encoded type (requests) already is that value. `Schema.Void` pairs with `ResponseBody.none`,
`Schema.Uint8ArrayFromSelf` with the byte codecs, and `Schema.instanceOf(FormData)` with the form-data codecs; these
identity schemas exist precisely so a caller-owned `Uint8Array` or `FormData` reaches the transport without a
transformation. Parsing stays a schema concern one level up: a `Schema.transformOrFail` whose _from_ side is
`Schema.String` or `Schema.Uint8ArrayFromSelf` serves both directions of a non-JSON format from one definition.
`examples/bodyCodecs.ts` keeps a typechecked endpoint for every codec so these pairings cannot silently rot.

`ResponseBody.uint8Array` reads a finite binary response, and `ResponseBody.formData` delegates multipart or
URL-encoded parsing to the provider. `ResponseBody.none` drains the incoming stream without accumulating its payload
and then decodes `undefined`; an absent stream reported as `EmptyBody` is already clean. It marks
itself as ineligible for default use, keeping body disposal explicit on a response rule whose schema input accepts
`undefined`. Custom codecs are default-capable without a marker; a codec can set `canBeDefault: false` to require the
same explicit per-rule use.

Responses that are defined to have no body, including `204`, `205`, `304`, and responses to `HEAD`, should select
`ResponseBody.none` explicitly. The request's `Accept` header is a negotiation preference, not a substitute for choosing
the correct response codec.

The effective default codec also supplies the request's content-negotiation hint: JSON sends
`Accept: application/json`, text sends `Accept: text/*`, bytes send `Accept: application/octet-stream`, form data sends
`Accept: multipart/form-data`, and a custom codec uses its optional `accept` value or falls back to `application/json`.
An explicit request header always wins. A per-rule codec does not change this request header because rule selection
happens after the response arrives; callers using text to parse JSON or another application media type should declare
the appropriate `Accept` header themselves.

Response rules already provide content-type-driven decoding when one status can carry several representations. Each
rule matches `content-type` with an exact value or predicate and selects its own codec and schema. The library does not
maintain a separate media-type registry or automatically override an explicit rule codec from the received header.

Query parameters and request headers remain unschematized. Query values are `string | true`: strings produce ordinary
`key=value` syntax, an empty string produces `key=`, and `true` produces the bare implicit-true form `key`. Explicit
booleans remain explicit strings (`"true"` or `"false"`), while omission uses `removeUrlParam`. The library owns query
serialization because WHATWG `URLSearchParams` normalizes `key` into `key=` and cannot preserve that distinction.
Singular and plural query setters replace the named values they receive while retaining unrelated API and endpoint
defaults; append operations support repeated parameters. The singular setters also operate on selected values:
`setUrlParam(key, current, replacement)` replaces every exact match in place, while `removeUrlParam(key, value)` removes
every exact match. They do nothing when the selected value is absent. Their two- and one-argument forms respectively
replace or remove every value for a key. Plural declarative removal lists accept either a key or `{ name, value }` for
targeted removal without adding overload ambiguity.

Header and query-parameter values are each either static or computed. A plain value is fixed at declaration; a
function of type `() => string | undefined` (or `() => QueryParamValue | undefined` for parameters) is called once per
plan evaluation while the request is materialized, and `undefined` omits the field. This exists because the most
common API-wide default — an `authorization` header — is not knowable when the API is declared: the session begins
later, changes on refresh, and ends on sign-out. Without computed values the only dynamic seam is `transformRequest`,
which runs after the declarative layer is materialized and therefore cannot be removed by `removeHeaders`, an endpoint
override, or a plan-level `removeHeader`. A computed value keeps the dynamic part inside the declarative layer, so
"authenticate by default, opt out where it does not apply" is expressible as configuration rather than as an
interceptor with a hand-maintained exclusion list.

Resolution is deliberately positioned: it happens after every default, override, and removal has composed, and before
the first request transform. A field that a declaration removed is therefore never computed, and a value resolving to
`undefined` never reaches the request. It also happens once per evaluation rather than once per attempt, because
encoding precedes the retry loop and attempts reuse the encoded request — a credential cannot change between attempts
of one operation. The functions run outside the Effect runtime and must be pure and cheap; anything fallible,
interruptible, or asynchronous belongs in a request transform, a client transform, or the application's own state
management. Targeted operations that select an existing value — `removeHeader(name, value)`,
`setHeader(name, current, replacement)`, and the query-parameter equivalents — match static values only, since a
computed entry has no value to compare until it runs; such entries are removed or replaced by name. Internally this
splits the canonical entry representation in two: declarations and plan state hold possibly computed entries, while
`HeaderEntries` — the representation providers see through `getHeaderEntries` and `attachHeaderEntries` — remains
materialized strings.

Request headers retain one entry per supplied value in the plan. `setHeader(name, value)` replaces every value for one
name, `setHeader(name, current, replacement)` replaces every exact match in place, `setHeaders` replaces the names
present in its input, `appendHeader` adds another value, and `removeHeader(name[, value])` removes either the whole
field or every exact matching value. Arrays and repeated iterable entries are therefore not flattened while composing
API, endpoint, and plan defaults. `mapRequest` and `mapClient` provide ordered plan-level escape hatches after API and
endpoint transforms; when a request transform changes a normalized field, that field becomes the transform's single
value.

Effect's request and response `Headers` types normalize each name to one string. Before execution, the library supplies
that representation for ordinary clients and also attaches the uncombined entries. A repeat-aware provider reads them
with `getHeaderEntries(request)` and should preserve that metadata through any preprocessing; constructing it with
`HttpClient.makeWith` is the direct path. Such a provider attaches raw response field lines with
`attachHeaderEntries(response, entries)`. Response header predicates receive both the normalized string and the entry
array. The default Fetch provider may combine repeated request fields, so APIs requiring separate physical field lines
need a provider that explicitly supports them. This is a provider capability limitation, not a plan-model limitation.

## Retry and cache policy

Retries default to zero. API and endpoint definitions can choose another default, and `.setRetries(n)` changes it at
one call site. `.setRetry({ times, schedule, mode, while, respectRetryAfter })` accepts an Effect `Schedule` directly;
a retry count without an explicit schedule uses jittered exponential backoff rather than immediate repeats. Counts
must be finite, non-negative integers.

Invalid retry counts, duplicate response tags, malformed path-argument objects, and invalid path-parameter values are
synchronous configuration defects represented by ordinary `Error` subclasses. They do not enter an Effect error
channel, and validation never executes the HTTP request.

The transient classification matches `HttpClient.retryTransient`: timeouts and transport failures, plus 408, 429, 500,
502, 503, and 504 responses. One retry counter and schedule state are shared across both kinds, so `times: 3` permits
at most four attempts even when transport errors and transient responses alternate. A mapped transient response is
still retried before rule selection. `while` can classify additional errors or responses as retryable without removing
the built-in transient cases. `mode` can restrict a policy to errors or responses when that distinction matters.

Retries are method-agnostic, so enabling them on a non-idempotent operation can repeat its side effects. Request schema
encoding, body construction, and plan transforms happen once per Effect evaluation, before the retry loop. The encoded
request is reused for all attempts; custom one-shot bodies must not be retried. `while` is short-circuited for built-in
transient cases and cannot be used as an observation hook for every attempt.

Intermediate retry responses are drained as streams without buffering the complete body before waiting, so the
connection can be reused during the backoff. A valid
`Retry-After` delta or HTTP date sets a minimum delay over the configured schedule; `respectRetryAfter: false` disables
that behavior for a server with unsuitable headers.

`timeout` options and `.setTimeout(...)` bound transport execution and decoding of the final response body.
Effect interruption propagates through the HTTP client, while a timeout becomes a transient `TimeoutException` that
can participate in the configured retry policy.

The current retry implementation gives disposal of a retryable response its own timeout window. If a schedule ends
after receiving such a response, final decoding also gets a fresh window. Disposal failures end the operation rather
than re-entering retry classification. Encoding, request/client transforms, and retry waits are outside these windows.
Use an outer `Effect.timeout` for a total operation deadline. Consolidating each attempt under one deadline is deferred
in [the review report](report.md).

No cache policy is supplied by default. API and endpoint definitions can specify a `CachePolicy`, and `.setCache(...)`
can replace or clear it at a call site. Its `control` field writes a standard `Cache-Control` request header for HTTP
caches and servers. Its optional `fetch` field controls Fetch's own cache mode, which is separate behavior and may be
ignored by non-Fetch transports. This keeps portable wire semantics distinct from provider-specific settings without
pretending one can fully replace the other. An explicit `Cache-Control` header wins over `CachePolicy.control`, and a
Fetch cache override merges into any application-provided `FetchHttpClient.RequestInit` instead of replacing it.

## Request gates

Request plans remain cold and repeatable. Stateful reuse is an explicit layer around an input-to-Effect function rather
than a hidden property of a plan:

```ts
const program = Effect.gen(function* () {
  const users = yield* makeRequestGate(
    (filters: Filters) =>
      getUsers().pipe(setUrlParam("page", String(filters.page)), setUrlParam("search", filters.search), toEffect),
    { key: ({ page, search }) => JSON.stringify([page, search]) },
  );

  yield* users.run(filters); // reuse when the key matches the latest success
  yield* users.refresh(filters); // bypass reuse for this input
  yield* users.reload; // rerun the input that produced the latest success
  yield* users.cancel; // interrupt superseded flights, keep the retained success
});
```

The key function makes equality explicit instead of guessing whether arbitrary objects are structurally equal. An
optional `equivalent` function supports composite keys that cannot use `Object.is`.

The gate retains only its latest successful input and value. A failed request does not replace that pair, which means a
temporary invalid form state cannot evict the last useful table result. Mapped HTTP responses remain successes here,
regardless of status. `run` first checks for an equivalent cached success, then joins the newest equivalent in-flight
request, or starts an execution. `refresh` and `reload` bypass both cache and flight reuse; concurrent forced requests
execute separately. A `run` during refresh can return the prior cached success. Different keys may run concurrently,
but older completions cannot overwrite newer successful completions. The cache is intentionally a single latest entry,
not a map: alternating `a`, `b`, `a`, `b` executes four times. `invalidate` clears the retained pair, interrupts every
request currently owned by that gate, completes their shared waiters with the interrupted exit, and prevents stale work
from repopulating the cache. `cancel` performs the same interruption and stale-write prevention but retains the cached
pair, which separates "this request is superseded" from "this value is wrong". Supersession patterns such as a
filter-as-you-type datatable need the former: the previous keystroke's request must stop on the wire, while the rows it
replaced stay available to `peek` and to an equivalent `run` until newer rows arrive. Clearing state and signaling
cancellation are uninterruptible together; neither operation waits for executing fibers' finalizers or transport
cleanup. `peek` reads the retained value without executing
anything. Here, newer means later-started: an earlier request finishing last cannot replace a later-started success,
but can be retained if all later requests failed.

Gate state has an explicit Effect lifetime: `makeRequestGate` allocates a new isolated gate. It is suitable for decoded,
reusable values, not live streaming bodies whose ownership cannot safely be shared. Interruption of the fiber executing
a shared request completes its waiters with the same interrupted exit; interrupting a fiber that is only waiting stops
that waiter without cancelling the shared execution. This ownership follows from the first caller executing the Effect
while later callers await its result. Synchronous throws while constructing the request Effect are captured as defects;
they still complete shared waiters and remove the flight so future calls can recover. Key and equivalence callbacks
should be pure. Inputs, keys, and results are retained by reference, so callers must not mutate them.

The chosen provider, not this library, decides which headers actually reach the wire. `FetchHttpClient` opens a client
span per request and, under Effect Platform's default tracer propagation, writes `traceparent` and `b3` headers into
it. In a browser this interacts with CORS: neither name is safelisted, so a cross-origin server must allow both or the
preflight fails before the request is sent, and the failure reaches the caller only as a transport error with the
browser's opaque cause. `transformClient` at API or endpoint scope and `.mapClient(...)` at plan scope accept
`HttpClient.withTracerPropagation(false)` for servers whose allow-list cannot be changed. This is provider behavior
rather than plan state, but it is documented here because it is only reachable through the provider seam this library
requires callers to fill.

Gate cancellation and ordinary request cancellation use Effect interruption rather than a transport-specific
`AbortController`. `FetchHttpClient` translates interruption to its internal abort signal. Other providers must make
their transport Effects interruptible. At a Promise boundary, callers can pass an external signal directly through
`Effect.runPromise(effect, { signal })`; inside Effect code, interrupting the request fiber is the native mechanism.

## Test shape

Three layers catch different failures:

1. Type assertions in unit tests verify body setters, inherited defaults, response replacement, discriminated envelope
   narrowing, and Effect requirements.
2. Unit tests under `src/` inject a fake Fetch implementation to check laziness, concurrent execution, schema failures,
   immutable overrides, retry/cache policy, response codecs, default merging, the unhandled-response path, and
   request-gate concurrency.
3. Integration tests under `tests/` run a disposable server on an ephemeral loopback port and use the real Fetch client.
   They exercise standard and extension methods, path interpolation, schema transformations and brands, JSON and text
   readers, XML request and response bodies, recursive JSON, transformed empty responses, request gates, ordinary
   request interruption, URL fragment handling, and mapped non-2xx responses without depending on an external service.

Run them separately with `pnpm test:unit` and `pnpm test:integration`, or together with `pnpm test`.

## Repository and release shape

Effect and Effect Platform are peer dependencies so consumers and the library share service identities. Packed files
include implementation sources for working source maps, exclude colocated unit tests, and expose both the root entry
point and `package.json`. The package metadata points to the Codeberg repository, and TypeScript checks the source with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` in addition to strict mode. `AnyResponseRule` is public for
application helpers that need to abstract over response-rule tuples.

The Woodpecker pipeline under `.woodpecker/` runs the same five checks required before local commits. It still has to
be enabled for the Codeberg repository before it can enforce them remotely.

The project is distributed under the MIT licence. The package metadata and repository `LICENSE` file carry the same
licence designation.

The version being prepared is `0.1.0-beta.1`. Distribution at this stage is a Codeberg revision and a locally built
tarball, with no registry publication or release tag implied. `private: true` prevents accidental registry publication;
the existing `publishConfig` is reserved for a future decision to publish. `pnpm pack` builds the ESM output through
`prepack`. Consumers should record the source commit because local builds share the same beta version.

The library declares a Node.js 20 runtime baseline. Development requires Node.js 22.13+ or 24 with the locked tool
versions; the configured CI image uses Node.js 24. Runtime verification on Node.js 20, browsers, and alternative
runtimes remains outstanding. The README describes local tarball consumption, and [report.md](report.md) records
the review findings left for a subsequent pass.

## Remaining design questions

1. **Streaming responses.** JSON, text, bytes, form data, and explicit no-body responses are finite codecs. A streaming
   response is a live, one-shot resource that cannot safely be cached or shared by a request gate. Decide whether it
   should use a separate plan terminal such as `.stream`, a non-retainable envelope type, or another ownership model
   before adding it.
2. **Typed query parameters and headers.** V1 intentionally keeps both stringly typed. If schemas are added later,
   decide whether typed setters replace the current setters or form a parallel API without making ordinary custom
   fields cumbersome.
3. **Additional response metadata.** Mapped envelopes deliberately omit the consumed `HttpClientResponse`. Decide
   which replay-safe derived values—such as the final URL, originating request, redirect information, or timing—are
   broadly useful enough to add to every envelope.
4. **API introspection.** `Api` exposes `baseUrl`, but not its fully merged headers, query parameters, response rules,
   transforms, or policies. Tooling and diagnostics may justify an immutable resolved-configuration snapshot; its
   representation must preserve repeated headers and parameters without exposing mutable declaration inputs.
5. **Retry lifecycle.** Should one deadline cover sending, disposal, and decoding, and should disposal failures consume
   retry budget? Should retries reject non-replayable bodies or accept a per-attempt body factory? Keep the current
   boundaries explicit until these semantics are settled. A consuming project has since supplied a concrete case for
   the per-attempt question: a server that echoes back a client-supplied attempt counter so the client can confirm
   which attempt a response answers. Because the request is encoded once before the retry loop — and computed header
   values and `mapRequest` resolve once per evaluation for the same reason — that counter cannot vary across built-in
   retries, and the consumer has to disable the policy and drive the loop over the plan itself. That works, but it
   trades away `Retry-After` handling and the jittered schedule. If a per-attempt hook is added, the narrowest useful
   form may be a per-attempt _request_ transform rather than a body factory.
6. **Configuration ownership.** Should declarations snapshot mutable collections, policies, and matchers, or should
   immutability remain a caller contract? Deep cloning arbitrary schemas, codecs, and domain values is not generally
   safe. Snapshotting only structural configuration may be a useful compromise.
7. **Dynamic type boundaries.** How should tuple rules with widened/union tags, dynamically supplied path templates,
   and possibly undefined default bodies degrade? Conservative inference or explicit rejection is preferable to
   promising response cases or executability that runtime configuration does not guarantee.
8. **Supported runtime matrix.** Is Node.js 20 still an intended compatibility target for the first beta, and are
   browsers or alternative runtimes release requirements? Choose the matrix and validate an installed tarball there
   before strengthening compatibility claims or publishing to a registry. One consuming project has since driven a
   packed tarball through a real browser against a live backend, covering JSON, text, byte, form-data, and no-body
   codecs, gate interruption, and mapped non-2xx responses; that is evidence for the browser row rather than a decision
   about the matrix, and Node.js 20 itself is still unverified.
9. **Dot-segment path values.** Should interpolation reject resulting whole `.` and `..` segments? URL parsing
   normalizes them, so percent-encoding alone cannot preserve their identity as opaque path values. Define the policy
   for adjacent placeholders and placeholders inside larger segments before tightening validation.

10. **Keyed gate retention.** A gate retains one latest success, so a filter-as-you-type caller — the motivating
    example in the README — almost never hits the cache: each keystroke is a distinct key, and it must cancel the
    previous flight anyway. Should gates optionally retain a bounded number of entries keyed by their key function, or
    is single-entry retention the deliberate whole of the feature, with multi-entry caching left to `Effect.cachedFunction`
    and friends? A bounded map changes eviction, invalidation scope, and the meaning of `reload` and `peek`.
11. **Cancellation scope.** `cancel` and `invalidate` both act on every request the gate owns. A caller that runs
    several keys concurrently — a dashboard with independent panels behind one gate — may want to supersede only the
    flights matching one key. Should either operation accept an optional input or key, or should such callers use one
    gate per key instead? The current whole-gate scope is the simpler contract and matches the single-entry cache.
12. **Provider presets.** The Fetch provider's tracing propagation is documented, but every browser consumer has to
    write the same `HttpClient.withTracerPropagation(false)` transform or the same server allow-list. Should the
    library ship an opinionated browser preset — a documented recipe, an exported client transform, or a layer — or
    does that overstep a library whose stated position is that the application chooses its transport?
13. **Typestate-changing transformations.** `RequestPlanTransform` covers plan operations that preserve `Body`,
    `Rules`, and `BodyReady`. Reusable transformations that add a response rule or supply a body change those
    parameters, so they can only be expressed per endpoint through `mapEndpoint`. Is a type-level counterpart — one
    that expresses "adds this rule to whatever rules the plan already has" — worth the inference complexity, or should
    such transformations stay endpoint-specific by design?
