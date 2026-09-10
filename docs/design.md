# Design sketch

The library defines an endpoint once, then creates immutable request plans at each call site. Endpoint functions take
only their required path values; endpoints without placeholders are zero-argument. A plan remains lazy while the caller
sets a body, query parameters, headers, execution policy, or response schemas; reading `.effect` produces the Effect
that sends and decodes the request.

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

A backslash escapes a literal colon that would otherwise look like a placeholder. This keeps action-style paths usable:

```ts
path: "/users/:userId\\:archive"; // getUser({ userId }) sends /users/<encoded-id>:archive
```

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

The current spike uses `@effect/platform`'s `HttpClient` service. The Effect keeps the transport as an explicit
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

`matched` preserves the complete selected matcher, and exact matcher headers are reflected in the header type. A mapped
envelope does not retain the original `HttpClientResponse`: its body has already been consumed and the response would
not be safely replayable from a request gate. `_tag`, `status`, and `matched` are deliberately redundant: `_tag` is the
Effect-compatible discriminant, `status` is the actual status (and remains a literal for exact status matchers), and
`matched` explains why the rule was selected. Effect's `Match` is useful for consuming the result but not for defining
the response table: its runtime cases erase the schema and context information the request factory needs to retain in
its generics.

`UnhandledResponse` retains the untouched `HttpClientResponse`, including its unconsumed body, instead of copying only
status and headers. Ownership of that live body transfers to the caller, which must consume or cancel it when recovering
from the error. `ResponseDecodeError` also retains response metadata and the schema cause, although its body has already
been consumed. Mapped `ResponseBody.none` responses are drained by the library.

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
  can intentionally re-add a removed name. A query-parameter removal deletes every repeated value for that name.
  Plan combinators remain singular `removeHeader(name)` and `removeUrlParam(name[, value])` operations. These
  declarative removals do not undo values introduced later by a request transform.

This replacement model keeps the common thin-object case precise: replacing the `200` schema removes the original
`200` body type, while inherited `404` and endpoint-specific `410` envelopes remain in the union.

## Bodies and request fields

The endpoint definition optionally declares a request body schema, but request bodies are never endpoint-function
arguments. Until `createUser().setBody(value)` supplies a value, the plan's `.effect` has the diagnostic
`RequestBodyRequired` type rather than an Effect. If an untyped caller bypasses this check, evaluating the underlying
value fails with `RequestBodyRequired` before the HTTP client is called.
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

`ResponseBody.none` drains the incoming body and then decodes `undefined`. It marks itself as ineligible for default
use, keeping body disposal explicit on a response rule whose schema input accepts `undefined`. Custom codecs are
default-capable without a marker; a codec can set `canBeDefault: false` to require the same explicit per-rule use.
Additional byte, form, multipart, or streaming codecs can be added without changing the rule shape.

Responses that are defined to have no body, including `204`, `205`, `304`, and responses to `HEAD`, should select
`ResponseBody.none` explicitly. The request's `Accept` header is a negotiation preference, not a substitute for choosing
the correct response codec.

The effective default codec also supplies the request's content-negotiation hint: JSON sends
`Accept: application/json`, text sends `Accept: text/*`, and a custom codec uses its optional `accept` value or falls
back to `application/json`. An explicit request header always wins. A per-rule codec does not change this request
header because rule selection happens after the response arrives; callers using text to parse JSON or another
application media type should declare the appropriate `Accept` header themselves.

Query parameters and request headers remain unschematized. Query values are `string | true`: strings produce ordinary
`key=value` syntax, an empty string produces `key=`, and `true` produces the bare implicit-true form `key`. Explicit
booleans remain explicit strings (`"true"` or `"false"`), while omission uses `removeUrlParam`. The library owns query
serialization because WHATWG `URLSearchParams` normalizes `key` into `key=` and cannot preserve that distinction.
Singular and plural query setters replace the named values they receive while retaining unrelated API and endpoint
defaults; append operations support repeated parameters. The singular setters also operate on selected values:
`setUrlParam(key, current, replacement)` replaces every exact match in place, while `removeUrlParam(key, value)` removes
every exact match. They do nothing when the selected value is absent. Their two- and one-argument forms respectively
replace or remove every value for a key. This finer-grained behavior is intentionally absent from plural operations,
where it would make merging ambiguous. Headers likewise have singular, plural, and removal setters. `mapRequest` and
`mapClient` provide ordered plan-level escape hatches after API and endpoint transforms.

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

Intermediate retry responses are drained before waiting so the connection can be reused during the backoff. A valid
`Retry-After` delta or HTTP date sets a minimum delay over the configured schedule; `respectRetryAfter: false` disables
that behavior for a server with unsuitable headers.

`timeout` options and `.setTimeout(...)` apply to each individual attempt, including decoding the final response body.
Effect interruption propagates through the HTTP client, while a timeout becomes a transient `TimeoutException` that
can participate in the configured retry policy.

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
const users =
  yield *
  makeRequestGate(
    (filters: Filters) =>
      getUsers().pipe(setUrlParam("page", String(filters.page)), setUrlParam("search", filters.search), toEffect),
    { key: ({ page, search }) => JSON.stringify([page, search]) },
  );

yield * users.run(filters); // reuse when the key matches the latest success
yield * users.refresh(filters); // bypass reuse for this input
yield * users.reload; // rerun the input that produced the latest success
```

The key function makes equality explicit instead of guessing whether arbitrary objects are structurally equal. An
optional `equivalent` function supports composite keys that cannot use `Object.is`.

The gate retains only its latest successful input and value. A failed request does not replace that pair, which means a
temporary invalid form state cannot evict the last useful table result. Mapped HTTP responses remain successes here,
regardless of status. Same-key concurrent calls share an in-flight request. Different keys may run concurrently, but an
older completion cannot overwrite a newer successful completion. `invalidate` clears the retained pair and prevents
requests that were already in flight from repopulating it; `peek` reads the retained value without executing anything.

Gate state has an explicit Effect lifetime: `makeRequestGate` allocates a new isolated gate. It is suitable for decoded,
reusable values, not live streaming bodies whose ownership cannot safely be shared. Interruption of the fiber executing
a shared request completes its waiters with the same interrupted exit.

## Test shape

Three layers catch different failures:

1. Type assertions in unit tests verify body setters, inherited defaults, response replacement, discriminated envelope
   narrowing, and Effect requirements.
2. Unit tests under `src/` inject a fake Fetch implementation to check laziness, schema failures, immutable overrides,
   retry/cache policy, default merging, the unhandled-response path, and request-gate concurrency.
3. Integration tests under `tests/` run a disposable server on an ephemeral loopback port and use the real Fetch client.
   They exercise standard and extension methods, path interpolation, schema transformations and brands, JSON and text
   readers, XML request and response bodies, recursive JSON, transformed empty responses, request gates, and mapped
   non-2xx responses without depending on an external service.

Run them separately with `pnpm test:unit` and `pnpm test:integration`, or together with `pnpm test`.

## Remaining design question

1. Which response codecs should follow JSON, text, and no-body: bytes, form data, multipart files, or streaming bodies?
