# Design sketch

The library defines an endpoint once, then creates immutable request plans at each call site. Every endpoint function
is zero-argument. A plan remains lazy while the caller sets a body, query parameters, headers, execution policy, or
response schemas; reading `.effect` produces the Effect that sends and decodes the request.

```ts
const api = createApi("https://api.example.com", {
  headers: { authorization: "Bearer ..." },
  retries: 0,
  responses: [response({ status: 404 }, MyApiNotFound)],
});

const getUsers = api.createRequest({
  method: "GET",
  path: "/users",
  responses: [
    response({ status: 200 }, Schema.Array(User)),
    response({ status: 204 }, Schema.Void, { body: "none" }),
    response({ status: 410 }, Gone),
  ],
});

const users = getUsers()
  .setUrlParam("fields", "id,name")
  .setResponseSchema({ status: 200 }, Schema.Array(ThinUser))
  .setCache("force-cache")
  .setRetries(3).effect;
```

Colon-prefixed path segments become positional endpoint arguments and are URL-encoded:

```ts
const getUserPost = api.createRequest({
  method: "GET",
  path: "/users/:userId/posts/:postId",
  responses: [response({ status: 200 }, BlogPost)],
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
  readonly status: 200;
  readonly headers: Headers;
  readonly body: ReadonlyArray<User>;
  readonly matched: { readonly status: 200 };
};
```

The actual type is a discriminated union over all response rules. Checking `response.status` narrows both the envelope
and its body without custom guards. `matched` preserves the selected matcher for cases where multiple schemas share a
status but differ by headers. Known matcher headers are also reflected in the header type.

`UnhandledResponse` retains the untouched `HttpClientResponse`, including its unconsumed body, instead of copying only
status and headers. The caller can inspect, log, stream, or decode that response when recovering from the error.

Files and multipart responses are intentionally not invented as a field yet. They should be introduced through body
codecs so the envelope accurately describes whether `body`, `files`, or both exist for that response rule.

## Defaults and overrides

- API response rules are inherited by every endpoint. This supports APIs with a common `404`, authentication response,
  maintenance response, or other shared response shape.
- An endpoint response rule replaces an inherited rule with the same status and header matcher.
- `setResponseSchema` replaces the rule with the same matcher for one request plan. Other response possibilities stay
  intact. If the matcher is new, it is added.
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

GET and HEAD definitions reject body schemas, and execution checks again after raw request transforms. This follows the
Fetch transport's actual constraint instead of advertising a request shape that its default transport cannot execute.

Query parameters and request headers remain raw platform inputs for now. The generic design leaves room for a later
typed API surface without making schemas for them part of the first version.

## Retry and cache policy

`retries` defaults to zero. API and endpoint definitions can choose another default, and `.setRetries(n)` changes it at
one call site. The spike delegates retry classification to `HttpClient.retryTransient`.

No cache option is supplied by default, preserving Fetch's default behavior. API and endpoint definitions can specify
a `RequestCache`, and `.setCache(...)` can replace it at a call site. For example, `"force-cache"` can serve a stable
dropdown while `"reload"` or `"no-store"` can power an explicit refresh. This option is Fetch-specific; non-Fetch
transports may ignore it, so a transport-neutral cache abstraction remains a later design problem.

## Test shape

Three layers catch different failures:

1. Type assertions in unit tests verify body setters, inherited defaults, response replacement, discriminated envelope
   narrowing, and Effect requirements.
2. Unit tests under `src/` inject a fake Fetch implementation to check laziness, schema failures, immutable overrides,
   retry/cache policy, default merging, and the unhandled-response path.
3. Integration tests under `tests/` run a disposable server on an ephemeral loopback port and use the real Fetch client.
   They check actual URL/header/body serialization and response handling without depending on an external service.

Run them separately with `pnpm test:unit` and `pnpm test:integration`, or together with `pnpm test`.

## Remaining design questions

1. Should header matchers remain exact literals, accept Effect Schemas, or use predicates? Schemas can validate and
   transform headers, while predicates express ranges and vendor content types more naturally.
2. For multiple response rules with the same status but different headers, is the `matched` field sufficient as a
   discriminator, or should response rules have explicit names such as `"thin-users"`?
3. Which response codecs are required initially beyond JSON and no-body: text, bytes, form data, multipart files, or
   streaming bodies?
4. Should retry configuration stay as a simple count plus advanced `transformClient`, or expose schedules and transient
   response classification directly?
