# Effect Schema HTTP

Lazy, schema-driven HTTP request plans for [Effect](https://effect.website/).

> **Beta:** `0.1.0-beta.1` is intended for evaluation and early adoption. The core model is tested, but public APIs may
> still change before a stable release.

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

## Installation

Install the package together with its Effect peer dependencies:

```sh
pnpm add viell-effect-schema-http effect @effect/platform
```

```sh
npm install viell-effect-schema-http effect @effect/platform
```

The package is ESM-only and supports Node.js 20 or newer. Browser and alternative JavaScript runtimes can use it when
they provide the Web Platform types required by their chosen Effect Platform HTTP client and body codecs.

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

The same program is maintained as a typechecked
[quick-start example](https://codeberg.org/viell/effect-schema-http/src/branch/main/examples/quickStart.ts).

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

Query values distinguish a bare key from an empty value: `true` produces `?preview`, while `""` produces `?preview=`.
Append operations support repeated query parameters and headers. Targeted setter and remover overloads operate on one
exact existing value.

## Body codecs

Response codecs read the transport body before its response schema decodes the resulting value:

| Codec                     | Schema input                           | Default `Accept`             |
| ------------------------- | -------------------------------------- | ---------------------------- |
| `ResponseBody.json`       | Parsed JSON                            | `application/json`           |
| `ResponseBody.text`       | `string`                               | `text/*`                     |
| `ResponseBody.uint8Array` | `Uint8Array`                           | `application/octet-stream`   |
| `ResponseBody.formData`   | `FormData`                             | `multipart/form-data`        |
| `ResponseBody.none`       | `undefined` after draining the payload | Rule-specific; never default |

Custom codecs can be installed at API, endpoint, rule, or plan scope. A text codec followed by a `*FromString` schema
can parse XML, YAML, a custom JSON dialect, or another textual protocol without special support from this library.

## Request gates

`makeRequestGate` adds explicit single-entry memoization around any input-to-Effect function:

```ts
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
  yield* users.invalidate; // clears retention and interrupts in-flight work
});
```

Equivalent concurrent calls share one execution. The gate deliberately remembers only its latest successful input and
value, not one value per key. Failures do not evict that success.

## Providers and cancellation

A request Effect requires `HttpClient.HttpClient`; the library never silently chooses a transport. Provide
`FetchHttpClient.layer`, another Effect Platform client, or a custom implementation. Effect interruption is the native
cancellation mechanism. `FetchHttpClient` translates interruption into its internal abort signal, and Promise callers
can pass a signal through `Effect.runPromise(effect, { signal })`.

Effect Platform normalizes headers. Plans retain repeated header entries separately, but the default Fetch provider may
combine them on the wire. APIs that require repeated physical header field lines need a provider that reads
`getHeaderEntries(request)` and preserves that representation.

## API overview

| API                                        | Purpose                                                       |
| ------------------------------------------ | ------------------------------------------------------------- |
| `createApi` / `extendApi`                  | Share and compose endpoint defaults                           |
| `createRequest`                            | Create a standalone endpoint                                  |
| `response`                                 | Associate a matcher, schema, and optional codec               |
| `RequestPlan` setters                      | Derive an immutable call-site request                         |
| `mapEndpoint`                              | Compose plan changes into another reusable endpoint           |
| `toEffect`                                 | Extract the executable Effect                                 |
| `makeRequestGate`                          | Add single-entry retention and in-flight de-duplication       |
| `attachHeaderEntries` / `getHeaderEntries` | Integrate providers that preserve repeated header field lines |

The source includes TSDoc for exported types and members. See the
[design document](https://codeberg.org/viell/effect-schema-http/src/branch/main/docs/design.md) for detailed semantics,
precedence rules, unusual HTTP cases, usage patterns, provider constraints, test strategy, and open design questions.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Unit and type-focused tests live beside the implementation under `src/`. Server-backed integration tests live under
`tests/` and bind only ephemeral loopback ports. See
[CONTRIBUTING.md](https://codeberg.org/viell/effect-schema-http/src/branch/main/CONTRIBUTING.md) for the complete
workflow.

## Licence

Distributed under the [MIT licence](LICENSE).
