# Design sketch

The library defines an endpoint once, then creates immutable request plans at each call site. Every endpoint function
is zero-argument. A plan remains lazy while the caller sets a body, query parameters, headers, execution policy, or
response schemas; reading `.effect` produces the Effect that sends and decodes the request.

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
    response({ key: "empty", status: 204 }, Schema.Void, { body: "none" }),
    response({ key: "gone", status: 410 }, Gone),
  ],
});

const users = getUsers()
  .setUrlParam("fields", "id,name")
  .setResponseSchema({ key: "ok", status: 200 }, Schema.Array(ThinUser))
  .setCache({ control: "max-age=3600", fetch: "force-cache" })
  .setRetries(3).effect;
```

Colon-prefixed path segments become positional endpoint arguments and are URL-encoded:

```ts
const getUserPost = api.createRequest({
  method: "GET",
  path: "/users/:userId/posts/:postId",
  responses: [response({ key: "ok", status: 200 }, BlogPost)],
});

const request = getUserPost(userId, postId);
```

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
  readonly matched: { readonly status: 200 };
};
```

The actual type is a discriminated union over all response rules. Each rule has a unique key, so checking
`response.key` narrows both the envelope and its body without custom guards, even when several rules share a status.
The key also makes the union work directly with Effect's `Match`:

```ts
const description = Match.value(result).pipe(
  Match.when({ key: "ok" }, ({ body }) => body.name),
  Match.when({ key: "not-found" }, ({ body }) => body.message),
  Match.when({ key: "gone" }, ({ body }) => body.deletedAt),
  Match.exhaustive,
);
```

`matched` preserves the complete selected matcher, and known matcher headers are reflected in the header type. Effect's
`Match` is useful for consuming the result but not for defining the response table: its runtime cases erase the schema
and context information the request factory needs to retain in its generics.

`UnhandledResponse` retains the untouched `HttpClientResponse`, including its unconsumed body, instead of copying only
status and headers. The caller can inspect, log, stream, or decode that response when recovering from the error.

Files and multipart responses are intentionally not invented as a field yet. They should be introduced through body
codecs so the envelope accurately describes whether `body`, `files`, or both exist for that response rule.

## Defaults and overrides

- API response rules are inherited by every endpoint. This supports APIs with a common `404`, authentication response,
  maintenance response, or other shared response shape.
- An endpoint response rule replaces an inherited rule with the same unique key.
- `setResponseSchema` replaces the rule with the same key for one request plan. Other response possibilities stay
  intact. It may change both the matcher and schema. If the key is new, the rule is added.
- Header-constrained rules beat status-only rules. Declaration order breaks equally specific ties.
- API options flow to endpoints and plans. Endpoint options override API defaults; plan setters override both.

This replacement model keeps the common thin-object case precise: replacing the `200` schema removes the original
`200` body type, while inherited `404` and endpoint-specific `410` envelopes remain in the union.

## Bodies and request fields

The endpoint definition optionally declares a request body schema, but the generated endpoint itself always takes no
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
  responses: [response({ key: "done", status: 204 }, Schema.Void, { body: "none" })],
});

const request = doFoo();
```

Such a plan is immediately executable, while `.setBody(...)` can still replace the static body at a call site.

GET and HEAD definitions reject body schemas, and execution checks again after raw request transforms. This follows the
Fetch transport's actual constraint instead of advertising a request shape that its default transport cannot execute.

Query parameters and request headers remain raw platform inputs for now. The generic design leaves room for a later
typed API surface without making schemas for them part of the first version.

## Retry and cache policy

`retries` defaults to zero. API and endpoint definitions can choose another default, and `.setRetries(n)` changes it at
one call site. The spike delegates retry classification to `HttpClient.retryTransient`.

No cache policy is supplied by default. API and endpoint definitions can specify a `CachePolicy`, and `.setCache(...)`
can replace or clear it at a call site. Its `control` field writes a standard `Cache-Control` request header for HTTP
caches and servers. Its optional `fetch` field controls Fetch's own cache mode, which is separate behavior and may be
ignored by non-Fetch transports. This keeps portable wire semantics distinct from provider-specific settings without
pretending one can fully replace the other.

## Test shape

Three layers catch different failures:

1. Type assertions in unit tests verify body setters, inherited defaults, response replacement, discriminated envelope
   narrowing, and Effect requirements.
2. Unit tests under `src/` inject a fake Fetch implementation to check laziness, schema failures, immutable overrides,
   retry/cache policy, default merging, and the unhandled-response path.
3. Integration tests under `tests/` run a disposable server on an ephemeral loopback port and use the real Fetch client.
   They exercise GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS; positional path interpolation; actual
   URL/header/body serialization; and mapped 404, 409, 410, and 501 responses without depending on an external service.

Run them separately with `pnpm test:unit` and `pnpm test:integration`, or together with `pnpm test`.

## Remaining design questions

1. Should header matchers remain exact literals, accept Effect Schemas, or use predicates? Schemas can validate and
   transform headers, while predicates express ranges and vendor content types more naturally.
2. Which response codecs are required initially beyond JSON and no-body: text, bytes, form data, multipart files, or
   streaming bodies?
3. Should retry configuration stay as a simple count plus advanced `transformClient`, or expose schedules and transient
   response classification directly?
