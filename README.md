# Effect Schema HTTP

Lazy, API-agnostic HTTP request plans built on Effect and Effect Schema. Define endpoint contracts, compose request
inputs without executing them, and interpret responses through status/header-selected rules. The consumer owns transport,
runtime, configuration and logging.

This checkout is `viell-effect-schema-http` **0.1.0-beta.2**. The local annotated tag
`before-effect-native-2026-09-12` preserves the beta.1 implementation before this redesign.

## Install and compose

Use compatible peers: `effect` 3.22.2 and `@effect/platform` 0.97.2. This private beta is distributed as a local archive:

```sh
pnpm pack --pack-destination ../test-llm1/vendor
```

The package is ESM-only. TypeScript consumers need Web API declarations for types such as `FormData` and `RequestCache`
(from `lib.dom` or compatible Node type definitions).

Install that archive in each consumer with `pnpm add path/to/viell-effect-schema-http-0.1.0-beta.2.tgz`.
Do not use `pnpm link` or `link:`: separate peer copies can make inferred Effect/Platform types nonportable.

```ts
import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { response, SchemaHttp, UrlEncoding } from "viell-effect-schema-http";

const SchemaHttpLive = SchemaHttp.layer({ timeout: "5 seconds" }).pipe(Layer.provide(UrlEncoding.Default));
const DefaultLive = Layer.mergeAll(SchemaHttpLive, FetchHttpClient.layer);
const runtime = ManagedRuntime.make(DefaultLive);

const program = Effect.gen(function* () {
  const schemaHttp = yield* SchemaHttp;
  const api = schemaHttp.createApi("https://example.test");
  const list = api.createRequest({
    method: "GET",
    path: "/users",
    urlParamsSchema: Schema.Struct({ page: Schema.NumberFromString }),
    responses: [response({ _tag: "ok", status: 200 }, Schema.Array(Schema.Struct({ name: Schema.String })))],
  });
  const plan = list().setUrlParams({ page: 2 });
  return yield* plan.effect;
});

// At the application's asynchronous entry point:
try {
  const result = await runtime.runPromise(program);
  console.log(result.body);
} finally {
  await runtime.dispose();
}
```

The URL above is illustrative. Declaring endpoints and changing plans is pure; reading `.effect` constructs a cold
Effect with a fresh object identity on every read; retain that Effect if using it as a dependency key. Each evaluation
encodes inputs and sends independently unless an interaction gate reuses the result.

`SchemaHttp.Default` is a ready-to-compose construction layer. `SchemaHttp.layer(options)` accepts shared request
defaults and requires UrlEncoding. Pure standalone `createApi`/`createRequest` factories remain available. Construction
merges headers/query keys and composes transforms from shared defaults before factory overrides, then endpoint options.
Scalar policies are overridden as whole values; `retries` also overrides an inherited `retry` policy. Construction does
not select a transport: execution requests the consumer's Platform HttpClient service.

## Schemas and wire codecs

Request schemas encode application values to wire values; response schemas decode wire values to application values.
Codecs handle body serialization and reading independently. Response rules match only status and headers, before body
consumption. Structural alternatives with identical metadata belong in a schema union.

- Headers and query parameters accept ordinary string collections unless their endpoint selects `headersSchema` or
  `urlParamsSchema`.
- A selected field schema owns the complete collection. Use `.setHeaders(domainValue)` or `.setUrlParams(domainValue)`.
  Raw individual setters, appenders and removers cannot bypass it. Field-schema errors and services enter the Effect type.
- Body schemas are optional. Use `body: RequestBody.uint8Array("image/png")` for a codec-only upload, and
  `response(matcher, ResponseBody.uint8Array)` for a codec-only download. Text, multipart, JSON and no-body readers also
  have explicit codecs. Selecting a schema always retains its validation/transformation.
- Body-bearing plans require `.setBody(...)` or a definitely defined `defaultBody`. Values remain caller-owned and should
  be treated as immutable. A possibly undefined default leaves the plan incomplete.
- Streaming is deferred; current built-in readers produce finite values.

**Selected field schemas can remove inherited defaults, including authorization.** A `Schema.Struct` strips fields it
does not declare. Include inherited credentials in the header schema (for example,
`authorization: Schema.optional(Schema.String)`) or keep the collection unschematized. To reject unexpected fields
before sending, annotate the selected schema with `.annotations({ parseOptions: { onExcessProperty: "error" } })`. This
uses the schema's own validation policy; inherited credentials are not merged back after encoding.

String header matchers compare the entire value: `"application/json"` does not match
`"application/json; charset=utf-8"`. Use a predicate that parses the media type when parameters should be ignored. Rules
with more header matchers rank first, then exact status, then declaration order. A predicate status with one header
matcher therefore outranks an exact status with no header matchers. A `204` with `Schema.Void` needs
`{ codec: ResponseBody.none }`; neither the status nor the schema automatically changes the default JSON reader.

A `Schema.NumberFromString` query field takes a number and encodes a string. With no schema, `.setUrlParam("page", "2")`
remains the direct plain-input path. See [design details](docs/design.md) for inheritance, repeated fields and codecs.

## Defaults and replacement

API defaults compose through `.extend(...)` and endpoint declarations. Plain values are static; computed header/query
values run once per evaluation before retries. Removing a declaration prevents its computation. Per-attempt work such
as signing belongs in client middleware.

`UrlEncoding.layer({ pathParameter, queryParameter, join })` accepts partial replacements. Default escaping preserves
empty strings and dot segments instead of imposing domain validation or path canonicalization. A selected provider may
normalize later; exact wire preservation requires a compatible provider. For example, substituting `".."` into
`/users/:id/profile` can make a WHATWG-based provider send `/profile`. Validate service identifiers before interpolation
when callers must stay within that route. Percent-encoding dots alone does not prevent this normalization. A replacement
`pathParameter` encoder must escape `/`, `?`, and `#` when values must remain a path component; leaving those delimiters
literal can create path segments, query parameters, or fragments.

For raw query fields, both `.setUrlParam("a", "9")` and `.setUrlParams({ a: "9" })` place replacement entries before
unaffected entries. Appenders add at the end; three-argument replacements preserve matching positions.

`diagnostics: true` emits Effect debug messages containing method and selected response status/tag. Default diagnostics
are off. Configure style, destinations and minimum level using Effect's Logger layers. ConfigProvider, Logger and other
application layers compose in the runtime; dependencies needed while a layer initializes must be provided to that layer.

Platform's request/response interfaces remain the current execution port. Fetch is demonstrated for browser and Node;
custom HttpClient providers are supported without importing browser or Node network primitives into library core.

Retries default to zero. Enabling them at API scope also replays POST/PATCH and other mutations; use them only when the
server and body support replay. `Retry-After` has no cap and can exceed the per-attempt timeout; wrap the complete
Effect in `Effect.timeout(...)` for a total deadline, or choose `respectRetryAfter: false` to use only the supplied
schedule. `cache.fetch` supplies a `FetchHttpClient.RequestInit` hint. Providers that do not consume that tag ignore it,
while `cache.control` supplies the ordinary `Cache-Control` header. This hint does not select a transport or implement
caching.

## Gates belong to interactions

```ts
import { Effect } from "effect";
import { makeRequestGate } from "viell-effect-schema-http";

const demo = Effect.gen(function* () {
  const gate = yield* makeRequestGate((query: string) => Effect.succeed({ query }), { key: (query) => query });
  const first = yield* gate.run("Ada");
  const reused = yield* gate.run("Ada");
  const refreshed = yield* gate.run("Ada", { force: true });
  yield* gate.dispose;
  return { first, reused, refreshed };
});
```

Allocate one gate per independently managed interaction, such as a mounted search box. Different input automatically
interrupts previous work. Equal active input joins the execution; otherwise equal retained input reuses one successful
result. Force interrupts and executes again even for equal input. A cache hit still interrupts superseded work.

Only the current flight may update retained success. Failed or superseded attempts preserve the last useful success.
Mapped non-2xx envelopes are Effect successes. Set `shouldCache: (result) => result._tag === "found"` in the gate's
options to retain selected outcomes while returning every result unchanged. The optional predicate receives `(value,
input)` and defaults to true. False clears an equivalent retained key and preserves an unrelated key; already-joined
callers still share the result. The predicate must be synchronous, pure and nonthrowing. Include response-affecting context in keys or gate ownership.

`dispose` permanently closes the gate, clears retention and awaits all owned work/finalizers. Future runs fail with
`GateClosed`. The initiating fiber owns shared execution; interrupting a waiter alone leaves it running. New requests
may overlap old finalizers. Keep a UI sequence guard so obsolete Promise callbacks cannot update the current screen.

Supersession ends callers with **fiber interruption**, outside the typed `E` channel. `runPromise` rejects; `catchAll`
and `catchTag` do not catch interruption. Use `runPromiseExit` at a Promise boundary:

```ts
import { Cause, Effect, Exit } from "effect";
import { makeRequestGate } from "viell-effect-schema-http";

const gate = await Effect.runPromise(
  makeRequestGate((query: string) => Effect.succeed(query), { key: (query) => query }),
);

async function search(query: string) {
  const exit = await Effect.runPromiseExit(gate.run(query));
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.isInterruptedOnly(exit.cause)) return undefined;
  throw new Error(Cause.pretty(exit.cause));
}

await search("Ada");
await Effect.runPromise(gate.dispose);
```

The application's sequence guard is still needed for stale results and callbacks. Pure interruption also covers
lifecycle or caller cancellation; it is not a distinct typed supersession error.

## Migration from beta.1

- Replace `refresh(input)` and `reload` with `run(currentInput, { force: true })`.
- Remove cancellation before each run; supersession is automatic.
- Replace lifecycle cancellation/invalidation with `dispose`, and allocate a new gate when remounting.
- Keep current input and rendered rows in application state; gate `peek` and standalone operation helpers are removed.
- Use `RawHeaderPlanTransform` / `RawQueryPlanTransform` for reusable raw field edits. A general
  `RequestPlanTransform` preserves both field-schema parameters as well as body/readiness/rules.
- Empty path parameters are accepted. Dynamic path strings take an explicit parameter map, including `{}` for no keys.
- Import from the package root; implementation modules moved into category directories and are not public subpaths.

## Verification and references

```sh
pnpm check
```

This runs tests, typechecking, Oxlint/ESLint, Prettier and a clean TypeScript build. Unit tests live beside source;
server-backed integration tests live in `tests/`. The two packed-consumer evaluations exercise Node and browser behavior,
including heterogeneous legacy protocols. A passing local run does not establish a universal provider/version matrix.

Read [docs/design.md](docs/design.md) for the implementation contract. The workspace's numbered in-depth report provides
an Effect introduction, complete tutorials, every public export and remaining design questions. The historical
[pre-beta report](docs/report.md) records the earlier review; it is not the current API contract.

## Application recipes

[Executable composition recipes](docs/recipes.md) demonstrate validated pagination metadata and created identifiers
from `Location` or a JSON body, plus creation/upload workflows with partial-failure checkpoints and upload-only recovery.
They use the ordinary library API with an injected Platform client and run under
`pnpm test`. [Pattern review](docs/adoption-review.md) explains their scope and the application policies kept outside
request machinery.
