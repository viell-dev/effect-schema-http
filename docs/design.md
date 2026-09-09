# Design sketch

The library defines an endpoint once, then creates immutable request plans at each call site. A plan is lazy: changing
query parameters, headers, request middleware, or response schemas creates a new plan, and reading `.effect` produces
the Effect that sends and decodes the request.

```ts
const getUsers = api.createRequest({
  method: "GET",
  path: "/users",
  responses: [
    response.success({ status: 200 }, Schema.Array(User)),
    response.success({ status: 200, headers: { "x-response-shape": "thin" } }, Schema.Array(ThinUser)),
    response.success({ status: 204 }, Schema.Void, { body: "none" }),
    response.failure({ status: 404 }, UserNotFound),
  ],
});

const users = getUsers()
  .setUrlParam("fields", "id,name")
  .addResponseSchema(
    response.success({ status: 200, headers: { "x-response-shape": "thin" } }, Schema.Array(ThinUser)),
  ).effect;
```

The current spike uses `@effect/platform`'s `HttpClient` service. The resulting Effect therefore keeps the transport as
an explicit requirement. Applications provide `FetchHttpClient.layer`, a Node client layer, or a test client. Calling
`.effect` does not choose a runtime or start a Promise.

## Proposed rules

- Response rules match status and exact, case-insensitive header names. Header-constrained rules beat status-only
  rules; declaration order breaks ties. This makes a default `200` and a more specific `200 + header` coexist without
  order-dependent surprises.
- A response rule states whether decoded data belongs in the success or error channel. HTTP status alone does not make
  that decision.
- JSON is the initial body codec. Empty responses explicitly use `{ body: "none" }`. Text, bytes, forms, streams, and
  content-type negotiation should be codecs rather than flags once their requirements are known.
- Call-site operations are immutable. `addResponseSchema` conservatively widens the result type because the original
  responses remain possible. A separate contract-replacement operation can intentionally narrow it later.
- An omitted request body schema makes a zero-argument endpoint. Supplying one makes the generated endpoint require
  exactly one decoded body value; Effect Schema encodes it before sending.
- `createApi(baseUrl, options)` only supplies defaults. `createRequest(...)` remains usable on its own.

## Test shape

Three layers are useful and catch different failures:

1. Type tests compile representative endpoint definitions and assert inferred success, failure, body, and Effect
   requirement types.
2. Unit tests inject a fake Fetch implementation to check laziness, matching precedence, schema failures, immutable
   overrides, default merging, and the unhandled-response path.
3. Integration tests run a disposable server on an ephemeral loopback port and use the real Fetch client. They check
   URL/header/body serialization, duplicate headers and query parameters, response body consumption, cancellation,
   timeouts, and connection errors without depending on an external service.

Run them separately with `pnpm test:unit` and `pnpm test:integration`, or together with `pnpm test`.

## Open design questions

1. Should decoded `4xx`/`5xx` schemas default to the Effect error channel, or should every mapping default to success
   unless explicitly marked as a failure?
2. Do endpoint functions with bodies look like `createUser(body)`, or should every endpoint stay zero-argument and use
   `createUser().setBody(body)`?
3. Should query, path, and request-header schemas be first-class endpoint inputs, or are schema-encoded bodies plus
   typed mutation methods enough for the first version?
4. Should response header matching remain exact literals, accept Effect Schemas, or use arbitrary predicates? Schemas
   can validate and transform headers, while predicates are easier for ranges and vendor content types.
5. When a call site knows that a mutation changes the contract, should it replace the entire response table (sound and
   narrow) or override one matcher (ergonomic but still a union with the remaining cases)?
6. What should callers receive: only the decoded body, or an envelope containing decoded body, status, and selected
   headers? Returning only the body is simplest but loses pagination, rate-limit, and caching metadata.
7. Are retries and caching configured as `HttpClient` middleware, per-plan Effect transforms, or both? Cache policy is
   often request metadata, while retry is execution policy; one generic `options` bag would blur that distinction.
