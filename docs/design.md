# Design sketch

The library defines an endpoint once, then creates immutable request plans at each call site. Endpoint functions take
only their required path values; endpoints without placeholders are zero-argument. A plan remains lazy while the caller
sets a body, query parameters, headers, execution policy, or response schemas; reading `.effect` produces the Effect
that sends and decodes the request.

```ts
const api = createApi("https://api.example.com", {
  headers: { authorization: "Bearer ..." },
  retries: 0,
  responses: [response({ key: "not-found", status: 404 }, MyApiNotFound)],
});

const getUsers = api.createRequest({
  method: "GET",
  path: "/users",
  responses: [
    response({ key: "ok", status: 200 }, Schema.Array(User)),
    response({ key: "empty", status: 204 }, Schema.Void, { codec: ResponseBody.none }),
    response({ key: "gone", status: 410 }, Gone),
  ],
});

const users = getUsers().pipe(
  setUrlParam("fields", "id,name"),
  setResponseSchema({ key: "ok", status: 200 }, Schema.Array(ThinUser)),
  setCache({ control: "max-age=3600", fetch: "force-cache" }),
  setRetries(3),
  toEffect,
);
```

Colon-prefixed placeholders become positional endpoint arguments and are URL-encoded. Placeholders can occupy a full
segment or appear inside one, such as `/files/:name.:ext` or `/v:version/users`. A runtime arity check rejects degraded
or untyped calls instead of sending unresolved placeholders:

```ts
const getUserPost = api.createRequest({
  method: "GET",
  path: "/users/:userId/posts/:postId",
  responses: [response({ key: "ok", status: 200 }, BlogPost)],
});

const request = getUserPost(userId, postId);
```

Plans, endpoints, and APIs are pipeable. Plan combinators preserve body typestate and response unions, while
`mapEndpoint` turns an endpoint into another ordinary endpoint with the same path arguments:

```ts
const getThinUsers = getUsers.pipe(
  mapEndpoint((plan) =>
    plan.pipe(setUrlParam("fields", "id,name"), setResponseSchema({ key: "ok", status: 200 }, Schema.Array(ThinUser))),
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
  readonly key: "ok";
  readonly status: 200;
  readonly headers: Headers;
  readonly body: ReadonlyArray<User>;
  readonly matched: { readonly key: "ok"; readonly status: 200 };
  readonly response: HttpClientResponse;
};
```

The actual type is a discriminated union over all response rules. Each declaration enforces unique keys at both the
type and runtime levels, so checking `response.key` narrows both the envelope and its body without custom guards, even
when several rules share a status. The key also makes the union work directly with Effect's `Match`:

```ts
const description = Match.value(result).pipe(
  Match.when({ key: "ok" }, ({ body }) => body.name),
  Match.when({ key: "not-found" }, ({ body }) => body.message),
  Match.when({ key: "gone" }, ({ body }) => body.deletedAt),
  Match.exhaustive,
);
```

`matched` preserves the complete selected matcher, and exact matcher headers are reflected in the header type. The raw
`HttpClientResponse` is also retained as `response`, covering redirect metadata, streaming, and other transport details
without discarding the typed envelope. `key`, `status`, and `matched` are deliberately redundant: `key` is the ergonomic
discriminant, `status` is the actual status (and remains a literal for exact status matchers), and `matched` explains why
the rule was selected. Effect's `Match` is useful for consuming the result but not for defining the response table: its
runtime cases erase the schema and context information the request factory needs to retain in its generics.

`UnhandledResponse` retains the untouched `HttpClientResponse`, including its unconsumed body, instead of copying only
status and headers. Ownership of that live body transfers to the caller, which must consume or cancel it when recovering
from the error. Mapped `ResponseBody.none` responses are drained by the library.

Files and multipart responses are intentionally not invented as a field yet. They should be introduced through body
codecs so the envelope accurately describes whether `body`, `files`, or both exist for that response rule.

## Defaults and overrides

- API response rules are inherited by every endpoint. This supports APIs with a common `404`, authentication response,
  maintenance response, or other shared response shape.
- An endpoint response rule replaces an inherited rule with the same unique key.
- `setResponseSchema` replaces the rule with the same key for one request plan. Other response possibilities stay
  intact. It may change both the matcher and schema. If the key is new, the rule is added.
- Status and header matchers accept exact values or predicates. Exact strings remain convenient, while predicates
  support status ranges and values such as `application/json; charset=utf-8` without introducing schema failures during
  rule selection.
- Header-constrained rules beat status-only rules. Within API and endpoint declarations, the first equally specific
  rule wins. A plan rule with a new key is prepended, so it wins an equally specific tie at that call site.
- API options flow to endpoints and plans. Endpoint options override API defaults; plan setters override both.
- `api.extend(options)` and pipeable `extendApi(options)` create a sub-API with merged headers, query parameters,
  policies, transforms, and response rules. APIs expose their base URL, and `setBaseUrl(...)` can redirect one plan to a
  mirror or alternate host.

This replacement model keeps the common thin-object case precise: replacing the `200` schema removes the original
`200` body type, while inherited `404` and endpoint-specific `410` envelopes remain in the union.

## Bodies and request fields

The endpoint definition optionally declares a request body schema, but request bodies are never endpoint-function
arguments. Until `createUser().setBody(value)` supplies a value, the plan's `.effect` is unavailable at the type level.
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
  responses: [response({ key: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
});

const request = doFoo();
```

Such a plan is immediately executable, while `.setBody(...)` can still replace the static body at a call site.

GET and HEAD definitions reject body schemas, and execution checks again after raw request transforms. This follows the
Fetch transport's actual constraint instead of advertising a request shape that its default transport cannot execute.
Other methods are intentionally open strings rather than a REST-shaped union. Standard methods and extension methods
such as `PROPFIND` use the same request machinery; the selected transport remains responsible for rejecting invalid or
forbidden method tokens.

Response body handling uses codec values rather than a growing string union. `ResponseBody.json` is the default and
uses the transport's JSON reader. `ResponseBody.text` reads the body as a string before schema decoding, so a schema can
parse JSON itself or decode XML, YAML, or a domain-specific text format. The default reader can be set at API, endpoint,
or plan scope; an explicit response-rule codec takes precedence. `ResponseBody.none` drains the incoming body and then
decodes `undefined`. The no-body codec only accepts schemas whose output type includes `undefined`, preventing
declarations that are guaranteed to fail. Additional byte, form, multipart, or streaming codecs can be added without
changing the rule shape.

Query parameters and request headers remain raw platform inputs for now. The generic design leaves room for a later
typed API surface without making schemas for them part of the first version. Singular and plural query setters replace
the named values they receive while retaining unrelated API and endpoint defaults; append and remove operations support
repeated parameters and explicit deletion. Headers likewise have singular, plural, and removal setters. `mapRequest`
and `mapClient` provide ordered plan-level escape hatches after API and endpoint transforms.

## Retry and cache policy

Retries default to zero. API and endpoint definitions can choose another default, and `.setRetries(n)` changes it at
one call site. `.setRetry({ times, schedule, mode })` accepts an Effect `Schedule` directly; a retry count without an
explicit schedule uses jittered exponential backoff rather than immediate repeats. Counts must be finite, non-negative
integers.

The transient classification matches `HttpClient.retryTransient`: timeouts and transport failures, plus 408, 429, 500,
502, 503, and 504 responses. A mapped transient response is still retried before rule selection, so a mapped 503 with
`times: 3` is returned after at most four attempts. Intermediate transient responses are drained before another request
is sent. `mode` can restrict a policy to errors or responses when that distinction matters.

`timeout` options and `.setTimeout(...)` apply to each individual attempt. Effect interruption propagates through the
HTTP client, while a timeout becomes a transient `TimeoutException` that can participate in the configured retry
policy.

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
   They exercise GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, and the extension method PROPFIND; positional path
   interpolation; actual URL/header/body serialization; and mapped 404, 409, 410, and 501 responses without depending
   on an external service.

Run them separately with `pnpm test:unit` and `pnpm test:integration`, or together with `pnpm test`.

## Remaining design questions

1. Which response codecs should follow JSON, text, and no-body: bytes, form data, multipart files, or streaming bodies?
2. Should custom retry classification become part of `RetryPolicy`, or remain an advanced client transform?
