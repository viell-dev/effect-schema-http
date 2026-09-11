# Effect Schema HTTP

Lazy, schema-driven HTTP request plans for [Effect](https://effect.website/).

> **Beta preparation:** `0.1.0-beta.1` is intended for evaluation in another project. Distribution is through Codeberg
> and local builds; there is no registry package yet. Public APIs may change before a stable release.

Effect Schema HTTP lets an application define an endpoint once and produce immutable request plans at each call site.
Every request and mapped response body passes through an Effect Schema. Plans stay cold while callers replace query
parameters, headers, schemas, codecs, retry behavior, caching, or other request details.

## Features

- Lazy, immutable, and pipeable request plans.
- Request-body encoding and response-body decoding through Effect Schema.
- Multiple normal response shapes selected by status and headers, including non-2xx responses.
- `_tag`-discriminated response unions compatible with `Match.tag`.
- Named and encoded path parameters such as `/users/:userId/posts/:postId`.
- API-, endpoint-, and call-site-level defaults and overrides.
- JSON, text, bytes, form-data, and explicit no-body response codecs.
- Retry schedules, per-attempt timeouts, `Retry-After`, cache policy, and Effect interruption.
- Optional single-entry request gates for memoization and concurrent-call de-duplication.
- An explicit `HttpClient` requirement: applications choose Fetch, Node, a test client, or a custom provider.

## Trying the beta

Clone a reviewed Codeberg revision, then build and pack it locally using Node.js 22.13+ or 24 and the pnpm version
declared in `package.json`:

```sh
git clone https://codeberg.org/viell/effect-schema-http.git
cd effect-schema-http
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

In the consuming project, install that tarball and compatible Effect peer dependencies:

```sh
pnpm add /path/to/effect-schema-http/viell-effect-schema-http-0.1.0-beta.1.tgz 'effect@^3.22.2' '@effect/platform@^0.97.2'
```

`pnpm pack` builds `dist/` automatically. Record the source commit alongside the tarball: the beta version alone does
not distinguish local builds. The package is marked private to prevent registry publication during this phase.

The output is ESM-only and declares a Node.js 20 runtime baseline; the development tools require a newer Node.js
version. A consuming project has since driven a packed tarball through Chromium with `FetchHttpClient`, covering every
body codec, retries, request gates, and mapped non-2xx responses; Node.js 20 itself, other browsers, alternative
runtimes, and official non-Fetch clients remain unverified. See [review findings](docs/report.md) for remaining
compatibility checks.

## Quick start

```ts
import { FetchHttpClient } from "@effect/platform";
import { Effect, Match, Schema } from "effect";
import { createApi, response, setUrlParam, toEffect } from "viell-effect-schema-http";

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const NotFound = Schema.Struct({
  resource: Schema.String,
  id: Schema.String,
});

const api = createApi("https://api.example.com", {
  headers: { authorization: "Bearer token" },
  responses: [response({ _tag: "not-found", status: 404 }, NotFound)],
});

const getUser = api.createRequest({
  method: "GET",
  path: "/users/:userId",
  responses: [response({ _tag: "ok", status: 200 }, User)],
});

const program = Effect.gen(function* () {
  const result = yield* getUser({ userId: "user-1" }).pipe(setUrlParam("expand", "profile"), toEffect);

  return Match.value(result).pipe(
    Match.tag("ok", ({ body }) => body.name),
    Match.tag("not-found", ({ body }) => `${body.resource} ${body.id} was not found`),
    Match.exhaustive,
  );
}).pipe(Effect.provide(FetchHttpClient.layer));

const name = await Effect.runPromise(program);
```

The same program is maintained as a typechecked [quick-start example](examples/quickStart.ts).

Calling `getUser(...)` and applying setters does not send anything. Executing the plan's Effect does. The same plan or
Effect can be executed repeatedly; each evaluation sends an independent request unless a request gate is used.

## Response rules

Mapped responses are normal success values regardless of status. A mapped `404`, `409`, `410`, or `501` stays in the
success channel; only an unmatched response becomes `UnhandledResponse`.

Rules can use exact values or predicates:

```ts
import { ResponseBody, response } from "viell-effect-schema-http";
import { Schema } from "effect";

const Document = Schema.Struct({ title: Schema.String });

const getDocument = api.createRequest({
  method: "GET",
  path: "/documents/:documentId",
  responses: [
    response(
      {
        _tag: "json",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("application/json") ?? false },
      },
      Document,
    ),
    response(
      {
        _tag: "text",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("text/plain") ?? false },
      },
      Schema.String,
      { codec: ResponseBody.text },
    ),
  ],
});
```

More header conditions are more specific; with equal header specificity, exact statuses beat status predicates.
Declaration order breaks any remaining tie. Tags must be unique within each declaration.

### Rules discriminate the envelope; schemas discriminate the body

Rules match on status and headers only. That is deliberate: selection happens before the body is read, so a rule can
be chosen without consuming a one-shot stream, and no response is buffered just to decide how to decode it.

A response whose _shape_ varies while its status and headers do not is therefore a schema concern, and
`Schema.Union` is the intended answer rather than a workaround. This is ordinary in well-designed APIs — a calendar
entry may be a single event, a repeating event, or an appointment inferred from another resource entirely, all of
them a perfectly correct `200`:

```ts
const CalendarEntry = Schema.Union(SingleEvent, RepeatingEvent, AssignmentEntry); // each with its own `_tag`

const getEntry = api.createRequest({
  method: "GET",
  path: "/calendar/:entryId",
  responses: [response({ _tag: "ok", status: 200 }, CalendarEntry)],
});
```

The two levels compose rather than compete. `Match.tag` on the envelope answers "what kind of _response_ is this",
and `Match.tag` on `body` answers "what kind of _value_ is this", each exhaustive in its own right. Reach for a rule
when the transport distinguishes the cases, and for a union when only the payload does.
Keep tags literal and declare reusable rule lists with `as const` for precise replacement inference. Ordinary rule
arrays retain a conservative union of possible responses when composed.

## Request bodies and call-site overrides

Request bodies are supplied on plans rather than as endpoint arguments:

```ts
const CreateUser = Schema.Struct({ name: Schema.String });

const createUser = api.createRequest({
  method: "POST",
  path: "/users",
  body: CreateUser,
  responses: [response({ _tag: "created", status: 201 }, User)],
});

const effect = createUser().setBody({ name: "Ada" }).effect;
```

Schemas encode ordinary domain values before a request-body codec serializes them. JSON is the default;
`RequestBody.text`, `RequestBody.uint8Array`, `RequestBody.urlParams`, and `RequestBody.formData` cover other finite
body types. A `defaultBody` supports RPC-style endpoints with static payloads.

Every setter returns another plan. This makes exceptional API calls local and composable:

```ts
const ThinUser = Schema.Struct({ id: Schema.String, name: Schema.String });

const getUsers = api.createRequest({
  method: "GET",
  path: "/users",
  responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
});

const thinUsers = getUsers()
  .setUrlParam("fields", "id,name")
  .setResponseSchema({ _tag: "ok", status: 200 }, Schema.Array(ThinUser))
  .setCache({ control: "max-age=3600", fetch: "force-cache" })
  .setRetries(3);
```

A fragment in a path is kept in the URL and query parameters are placed before it, but **no HTTP client sends a
fragment** — it is stripped before the request leaves. A path declared as `/users/:userId#thin` reaches the server as
`/users/u-1`, so an API cannot use a fragment to select a representation; use a query parameter or a header. A `#`
inside a path or query _value_ is percent-encoded and cannot truncate the URL.

Query values distinguish a bare key from an empty value: `true` produces `?preview`, while `""` produces `?preview=`.
Append operations support repeated query parameters and headers. Targeted setter and remover overloads operate on one
exact existing value.

### Static and computed values

A header or query-parameter value is either a plain value, which is fixed when it is declared, or a function, which is
called once per plan evaluation while the request is materialized. Returning `undefined` omits the field or parameter
entirely:

```ts
const api = createApi("https://api.example.com", {
  headers: { authorization: () => (session.token === undefined ? undefined : `Bearer ${session.token}`) },
  urlParams: { preview: () => (settings.previewMode ? true : undefined) },
});
```

This is what makes an API-wide authentication default workable: the value is read from live application state at send
time rather than captured when the API was declared, so one API object survives signing in, refreshing, and signing
out, and a plan retained across those events sends the current token rather than a stale one.

Crucially, a computed value is still an ordinary **declared** header. It participates in the normal composition rules,
so an API-wide default can be taken away by the layers below it:

```ts
const publicApi = api.pipe(extendApi({ removeHeaders: ["authorization"] }));

const login = api.createRequest({ method: "POST", path: "/login", removeHeaders: ["authorization"], ... });
const probe = getUser({ userId }).removeHeader("authorization");
```

A field removed by any of those is never computed at all. This is the difference between a computed value and a
request transform: `transformRequest` runs _after_ the declarative layer is materialized, so nothing can remove what it
adds. Reach for a transform when the change genuinely needs the built request; use a computed value when it is a
header or parameter whose value simply is not known yet.

Rules worth knowing:

- **Plain values are for static data only.** Anything that varies over the life of the API belongs in a function.
- **Functions must be pure and cheap.** They run outside the Effect runtime, so they cannot fail, retry, or be
  interrupted; use a request transform, `mapClient`, or a gate for anything effectful.
- **Resolution happens once per evaluation, not per attempt.** Request encoding runs before the retry loop, so every
  retry attempt reuses the value computed for that evaluation — a token cannot change mid-retry. The same is true of
  `mapRequest`. A request that must genuinely differ per attempt — an incrementing attempt counter a server echoes
  back for correlation, for instance — cannot use the built-in retry policy: disable it with `setRetries(0)` and loop
  over the plan yourself, executing it again with different values each time. Plans are cold and re-executable, so
  that loop is ordinary code rather than a second call site.
- **Targeted operations match static values only.** `removeHeader(name, value)`,
  `setHeader(name, current, replacement)`, and their query-parameter equivalents select an existing value, which a
  function does not have until it runs. Remove or replace a computed entry by name.
- **Request gates key on their input, not on headers.** A cached success is reused even if a computed value would now
  produce something different; call `refresh` or `invalidate` when a credential change should invalidate what a gate
  remembers.

### Reusable cross-endpoint setters

A plan's `Body`, `Rules`, and `BodyReady` type parameters differ per endpoint, so a helper written against one
concrete `RequestPlan` is not reusable. `RequestPlanTransform` is the polymorphic type every pipeable setter already
returns; annotate a shared helper with it and it composes into any endpoint's plan without casts:

```ts
import { appendHeader, setHeader, type RequestPlanTransform } from "viell-effect-schema-http";

const withAuth =
  (token: string): RequestPlanTransform =>
  (plan) =>
    plan.setHeader("authorization", `Bearer ${token}`).appendHeader("x-request-source", "web");

const user = getUser({ userId }).pipe(withAuth(token), setUrlParam("expand", "profile"), toEffect);
const created = createUser().setBody({ name: "Ada" }).pipe(withAuth(token), toEffect);
```

A helper that only applies one setter needs no wrapper: `setHeader("x-tenant", tenant)` and
`appendHeader("accept-language", locale)` are already values of this type. Transformations that change response rules
or supply a body change the plan's type parameters and cannot use it; compose those per endpoint with `mapEndpoint`.

## Body codecs

Response codecs read the transport body before its response schema decodes the resulting value:

| Codec                     | Schema input                           | Schema that pairs with it                                | Default `Accept`             |
| ------------------------- | -------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| `ResponseBody.json`       | Parsed JSON                            | Any schema; the default needs no configuration           | `application/json`           |
| `ResponseBody.text`       | `string`                               | `Schema.String`, or a `*FromString` transformation       | `text/*`                     |
| `ResponseBody.uint8Array` | `Uint8Array`                           | `Schema.Uint8ArrayFromSelf`, or a transformation from it | `application/octet-stream`   |
| `ResponseBody.formData`   | `FormData`                             | `Schema.instanceOf(FormData)`                            | `multipart/form-data`        |
| `ResponseBody.none`       | `undefined` after draining the payload | `Schema.Void`                                            | Rule-specific; never default |

Request codecs receive the schema's **encoded** value, so the same pairings apply in the other direction:

| Codec                            | Encoded type it requires   | Schema that pairs with it                                |
| -------------------------------- | -------------------------- | -------------------------------------------------------- |
| `RequestBody.json`               | Any JSON-compatible value  | Any schema; the default needs no configuration           |
| `RequestBody.text(contentType?)` | `string`                   | `Schema.String`, or a `*FromString` transformation       |
| `RequestBody.uint8Array(type?)`  | `Uint8Array`               | `Schema.Uint8ArrayFromSelf`, or a transformation from it |
| `RequestBody.urlParams`          | Record of coercible values | `Schema.Struct` of strings, numbers, booleans, or arrays |
| `RequestBody.formData`           | `FormData`                 | `Schema.instanceOf(FormData)`                            |

`Schema.instanceOf(FormData)` and `Schema.Uint8ArrayFromSelf` are identity schemas: their `Type` and `Encoded` are the
same value the codec already handles, so the caller's own `FormData` or `Uint8Array` reaches the transport untouched.
When the payload needs real parsing, keep that in the schema instead — a `Schema.transformOrFail` from
`Schema.String` or `Schema.Uint8ArrayFromSelf` decodes a response and encodes a request from one definition.
[examples/bodyCodecs.ts](examples/bodyCodecs.ts) is a typechecked endpoint for every row of both tables.

Custom codecs can be installed at API, endpoint, rule, or plan scope. A text codec followed by a `*FromString` schema
can parse XML, YAML, a custom JSON dialect, or another textual protocol without special support from this library.

Use `ResponseBody.none` explicitly for `HEAD`, `204`, or other bodyless responses. The default JSON codec rejects
empty and whitespace-only payloads. A rule-specific codec does not change the request's default `Accept` header;
set that header explicitly when negotiating another representation.

## Failures, retries, and body ownership

Schema encoding failures become `RequestBodyEncodeError`; response schema failures become `ResponseDecodeError`.
Transport and response codec failures use Effect Platform HTTP errors. A body-bearing plan needs `.setBody(...)` or a
defined `defaultBody` before its Effect is available in the type system. Path argument and retry-count validation can
throw synchronously while configuring a plan.

Unmatched response bodies are drained by default. With `.setUnhandledResponseBody("retain")`, the caller owns the
body on `UnhandledResponse.response` and must consume it or execute `error.discard`. Such live responses are unsuitable
for sharing through a request gate.

Retries default to zero. Enabling them also retries mapped transient statuses: `408`, `429`, `500`, `502`, `503`, and
`504`. `times` counts additional attempts, and `while` only adds retryable cases; it cannot veto built-in cases.
Retries apply to every method, including `POST`, so enable them only when replay is acceptable for that endpoint.
Request encoding runs once per plan evaluation; retry attempts reuse the encoded request body.

`setTimeout` bounds transport and final response decoding for each attempt. Encoding, transforms, and retry waits are
outside that timeout. Retried response disposal currently has a separate timeout window. To bound the whole operation,
apply `Effect.timeout` to the extracted Effect. Deferred retry concerns are tracked in [the review](docs/report.md).

## Request gates

`makeRequestGate` adds explicit single-entry memoization around any input-to-Effect function:

```ts
import { makeRequestGate } from "viell-effect-schema-http";

type Filters = { readonly page: number; readonly search: string };

const usersGate = makeRequestGate(
  (filters: Filters) =>
    getUsers().pipe(setUrlParam("page", String(filters.page)), setUrlParam("search", filters.search), toEffect),
  { key: ({ page, search }) => JSON.stringify([page, search]) },
);

const gatedProgram = Effect.gen(function* () {
  const users = yield* usersGate;
  const filters = { page: 1, search: "Ada" };

  yield* users.run(filters); // executes
  yield* users.run(filters); // reuses the latest equivalent success
  yield* users.refresh(filters); // always executes
  yield* users.reload; // executes the latest successful input again
  yield* users.cancel; // interrupts in-flight work and keeps retention
  yield* users.invalidate; // clears retention and interrupts in-flight work
});
```

Equivalent concurrent `run` calls share one execution when there is no equivalent cached success. `refresh` and
`reload` always start separate executions; `run` can still return a cached success while a refresh is running. The gate
remembers only its latest successful input and value, not one value per key. Failures do not evict that success, and
mapped non-2xx responses also count as successes. Treat inputs, keys, and cached values as immutable.

Interrupting the first caller interrupts the shared execution and its waiters. Interrupting a waiter only stops that
waiter. `cancel` and `invalidate` signal cancellation but do not wait for transport cleanup to finish.

### Superseding an in-flight request

A gate retains a stale result rather than cancelling the request that produced it: "older completions cannot overwrite
newer successful completions" is a correctness guarantee, not a cancellation one. A filter-as-you-type box wants the
superseded request to stop on the wire too, which is what `cancel` and `invalidate` provide. Use `cancel` unless the
retained value itself has become wrong:

```ts
const applyFilters = (filters: Filters) => usersGate.cancel.pipe(Effect.zipRight(usersGate.run(filters)));
```

`cancel` interrupts every request the gate currently owns, completes their shared waiters with the interrupted exit,
and prevents those executions from repopulating the cache — while keeping the latest retained success available to
`peek` and to an equivalent `run`. `invalidate` does the same and additionally clears that success, which is the right
choice after a mutation invalidates what the gate remembers. Both are the gate-level vocabulary for the
`Effect.runFork` + `Fiber.interrupt` pattern; interruption reaches the transport the same way (see
[Providers and cancellation](#providers-and-cancellation)).

## Providers and cancellation

A request Effect requires `HttpClient.HttpClient`; the library never silently chooses a transport. Provide
`FetchHttpClient.layer`, another Effect Platform client, or a custom implementation. Effect interruption is the native
cancellation mechanism. `FetchHttpClient` translates interruption into its internal abort signal, and Promise callers
can pass a signal through `Effect.runPromise(effect, { signal })`.

Effect Platform normalizes headers. Plans retain repeated header entries separately, but the default Fetch provider may
combine them on the wire. APIs that require repeated physical header field lines need a provider that reads
`getHeaderEntries(request)` and preserves that representation.

### Browsers and CORS

`FetchHttpClient` opens a client span for every request and, with tracer propagation enabled — the Effect Platform
default — writes that span into `traceparent` and `b3` request headers. Neither is CORS-safelisted, so a cross-origin
server must name both in `Access-Control-Allow-Headers` (or reflect `Access-Control-Request-Headers`) or every call
fails at the preflight. Combined with the `authorization` and `content-type` headers most APIs already need, a
browser application should expect a preflight on essentially every request.

A rejected preflight reaches the caller as an Effect Platform `RequestError` with `reason: "Transport"`, whose cause is
the browser's deliberately opaque `TypeError: Failed to fetch`; the specific header is named only in the browser
console. Check the console first when a request that works from `curl` or Node fails in a browser.

Turn propagation off when the server is not under your control:

```ts
import { HttpClient } from "@effect/platform";

const api = createApi("https://api.example.com", {
  transformClient: HttpClient.withTracerPropagation(false),
});
```

`transformClient` is available on API and endpoint declarations, and `.mapClient(...)` applies the same change to one
plan. Prefer allowing the headers when you own the server: the propagated span is what links a browser request to its
server-side trace.

## API overview

| API                                        | Purpose                                                       |
| ------------------------------------------ | ------------------------------------------------------------- |
| `createApi` / `extendApi`                  | Share and compose endpoint defaults                           |
| `createRequest`                            | Create a standalone endpoint                                  |
| `response`                                 | Associate a matcher, schema, and optional codec               |
| `RequestPlan` setters                      | Derive an immutable call-site request                         |
| `RequestPlanTransform`                     | Type a reusable plan setter shared by several endpoints       |
| `mapEndpoint`                              | Compose plan changes into another reusable endpoint           |
| `toEffect`                                 | Extract the executable Effect                                 |
| `makeRequestGate`                          | Add single-entry retention and in-flight de-duplication       |
| `attachHeaderEntries` / `getHeaderEntries` | Integrate providers that preserve repeated header field lines |

The source includes TSDoc for exported types and members. See the [design document](docs/design.md) for detailed
semantics, precedence rules, unusual HTTP cases, usage patterns, provider constraints, test strategy, and open design
questions.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

Unit and type-focused tests live beside the implementation under `src/`. Server-backed integration tests live under
`tests/` and bind only ephemeral loopback ports. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete workflow.

## Licence

Distributed under the [MIT licence](LICENSE).
