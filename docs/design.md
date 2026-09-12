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

Each value must be a string and is encoded with `encodeURIComponent`. In particular, `/` in an opaque value
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

Rule selection reads status and headers, never the body. This is a deliberate boundary rather than a missing feature:
the body is a one-shot stream, so choosing a rule by inspecting it would mean buffering every response before knowing
how — or whether — to decode it, and would make rule selection fallible in a way matching cannot currently be. The
consequence is that the envelope union and the body union are separate, composable layers. A response whose status and
headers are fixed but whose payload legitimately varies belongs in a `Schema.Union`, and that is the intended
expression of it, not a fallback: a calendar entry that may be a single event, a repeating event, or an appointment
inferred from an unrelated resource is one `200` rule whose schema is a three-member union, each member carrying its
own `_tag` and each exhaustively matchable. `Match.tag` over the envelope asks what kind of response arrived;
`Match.tag` over `body` asks what kind of value it carries. An API that instead collapses success and failure into one
status with an `ok`/`error` field in the body is served by the same mechanism, but that is a defect in the API rather
than a case the model is built for — the transport-level outcome and the payload's variance are different questions,
and such an API has answered only one of them.

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

## Construction services and organization

`SchemaHttp` is an Effect Context.Tag exposing pure `createApi` and `createRequest` factories. Its layer captures shared
RequestOptions and a UrlEncoding service. SchemaHttp.Default provides default encoding; SchemaHttp.layer(options)
requires an encoding layer. Factories and setters remain pure; created plan Effects obtain HttpClient and schema services
from the execution context. Standalone factories also remain available.

UrlEncoding supplies pure pathParameter, queryParameter and join functions. Its layer accepts partial replacements.
Defaults escape values without rejecting empty strings or canonicalizing dot segments. Downstream providers retain their
own URL behavior. Diagnostics default off; when enabled they emit method/status/tag through Effect.logDebug. Logger
style/level/destinations and ConfigProvider are owned by application layers and runtimes.

Source lives in category directories: api, request, request/query, request/retry, encoding, headers, body, response,
errors and gate. main.ts is the sole root file and re-exports the supported package surface. There are no index.ts files.
A directory need not have a paired entry module; named entry files are allowed where useful.

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

Without a selected field schema, query parameters and request headers accept plain declarations. Query values are
`string | true`: strings produce ordinary
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

### Optional field schemas and codec-only bodies

`headersSchema` and `urlParamsSchema` independently select a complete collection schema. Definition values and plural
plan setters accept the schema's Type; execution validates/encodes with Schema.encodeUnknown before ordinary wire
serialization. The Encoded type must be a collection of materialized strings (plus true for bare query flags), repeated
arrays or entries, not computed functions. Schema contexts and RequestFieldsEncodeError propagate through the Effect.

Raw single-field setters, appenders and removers are unavailable and reject untyped calls for a schema-owned collection.
The other collection remains independent. Each plural setter replaces the previous typed input; inherited declarations
are merged beneath it. Overrides suppress computed defaults before evaluation. Repeated inherited entries become arrays,
while one entry becomes a scalar; provide explicit typed input when that loses required cardinality information. Header
schema models should use lower-case keys to match inherited names. Schema excess-property behavior also applies to
inherited defaults, so include defaults such as authorization in a selected header schema when they should survive.

A body declaration can instead select a RequestBody codec directly. setBody then accepts its input type, without schema
validation, and readiness remains required. A codec-only response rule uses response(matcher, codec) and returns the codec
output type. Schema-bearing declarations always retain schema encoding/decoding. Binary and multipart data no longer
require identity schemas purely to access a codec. Streaming remains deferred.

Schema application input need not be a plain record: arrays, class instances, scalars and explicit `undefined` are
passed intact to encoding and replace the inherited collection completely, suppressing its computed defaults. Plain
record input merges inherited declarations underneath it. Omitting input constructs an inherited record; explicitly
supplying `undefined` instead validates that value against the selected schema.

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

The gate belongs to one independently managed interaction. Its API is `run(input, { force?: boolean })` and `dispose`.
A changed input automatically interrupts the current execution. Equal input joins active work before considering the
single retained success; force replaces current work and bypasses retention even when input is equal. Returning a
cached value also interrupts any superseded active execution.

The constructor allocates Ref/Deferred state without requiring the operation's services. The run Effect propagates its
operation's A/E/R plus GateClosed. Only the still-current flight may populate retained success. Failure retains the
previous success; a superseded uninterruptible completion cannot later overwrite it. Result/key objects remain
caller-owned immutable references.

`RequestGateOptions<Input, Key, A = unknown>` accepts `shouldCache?: (value: A, input: Input) => boolean`.
The result type is inferred from the operation, and the predicate defaults to true. It runs once per successful
underlying execution, not for cache hits, joining callers or Effect failures. It controls retention without changing
returned values or their success/error classification. False clears an equivalent retained key, using the configured
equivalence, while preserving an unrelated key. Only the current flight can apply either retention change.

A forced run returning an excluded response therefore clears its same-key retained value so the next run executes.
The predicate must be pure, synchronous and nonthrowing. It runs within the captured execution so accidental throws
become defects and still complete cleanup and shared callers; defects preserve retention. A cache hit does not
reevaluate policy, so response-affecting context belongs in keys or gate ownership.

The initiating fiber owns execution and resolves a shared Deferred. Waiter interruption does not interrupt that owner;
owner interruption interrupts the shared work. Coordination and completion bookkeeping are protected with
uninterruptibleMask; execution and waits restore ordinary interruptibility. Callback construction is suspended so
synchronous defects still release flight state and waiters.

Disposal permanently closes the gate, clears retention, signals every owned flight and awaits their completion,
including superseded flights still finalizing. Concurrent disposal calls await the same completion. Subsequent runs fail
with GateClosed. Call disposal from the interaction owner, not reentrantly from the operation being disposed.

New execution does not wait for old finalizers, so provider cleanup may overlap. A UI still needs presentation ownership
such as an invocation sequence. The gate does not expose peek/refresh/reload/cancel/invalidate or standalone gate-operation
helpers. A force action submits current input with `{ force: true }`; the UI owns current input and displayed rows.

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

The version being prepared is `0.1.0-beta.2`. Distribution at this stage is a Codeberg revision and a locally built
tarball, with no registry publication or release tag implied. `private: true` prevents accidental registry publication;
the existing `publishConfig` is reserved for a future decision to publish. `pnpm pack` builds the ESM output through
`prepack`. Consumers should record the source commit because local builds share the same beta version.

The library declares a Node.js 20 runtime baseline. Development requires Node.js 22.13+ or 24 with the locked tool
versions; the configured CI image uses Node.js 24. Runtime verification on Node.js 20, browsers, and alternative
runtimes remains outstanding. The README describes local tarball consumption, and [report.md](report.md) records
the review findings left for a subsequent pass.

## Remaining design questions

The confirmed direction favors consumer control, Effect-native composition, useful replaceable defaults, simple
interaction ownership and optional schema mapping. Beta.2 applies these through SchemaHttp, UrlEncoding, field schemas,
codec-only bodies and the simplified gate. Open implementation contracts remain:

1. Widened or union-valued response-tag replacement needs conservative type inference matching runtime equality.
2. Structural snapshotting versus caller immutability remains explicit; deep cloning arbitrary domain behavior is not a
   general solution.
3. Retry timeout/disposal paths do not constitute one unified complete attempt lifetime. Replay still reuses the encoded
   request rather than rerunning schema encoding or a body factory on every attempt.
4. Streaming is deferred; ownership, incremental validation, sharing and partial-consumption retries need a separate design.
5. Field schemas currently own complete collections. Finer composition, typed inherited defaults and scalar versus
   one-element-array inheritance need concrete consumer cases before additional APIs.
6. Additional response metadata and declaration introspection need concrete consumers and clear lifetime/redaction boundaries.
7. Gate reference-counted sharing, multi-entry retention and provider presets are not established requirements. Prefer
   composition and independent interaction owners unless a concrete case requires more.
8. Web and Node are primary targets; the exact maintained release/provider/version matrix remains to be established.
9. Platform interfaces remain the execution port. Replacing those interfaces, rather than only their providers, requires
   a distinct adapter design.

Empty strings and dot segments are accepted deliberately; library-level canonicalization is not a pending fix. Dynamic
paths now require a runtime-checked parameter map, and possibly undefined default bodies leave typestate incomplete.

## Application composition recipes

The metadata-aware catalog recipe in [recipes.md](recipes.md) demonstrates required pagination-header validation,
`200`/`204` normalization and a rule-specific created-ID codec with header precedence and JSON fallback. Header success
drains the unused body. These are API-specific policies implemented through existing public codecs, schema decoding
and Effect composition, not package-root APIs. Recipe tests live beside the examples and run in `pnpm test`.

The [attachment workflow recipe](recipes.md#creation-and-recoverable-attachment-uploads) validates all input before
creation, records acknowledged progress in an application-owned Ref, and resumes pending uploads without reissuing
creation. Its typed upload error retains the original cause and checkpoint. HTTP execution is interruptible; only
checkpoint bookkeeping is protected. Idempotent named-attachment replacement, sequential execution and checkpoint
storage are explicit example-service choices. No workflow or transaction API is added to the package exports.
