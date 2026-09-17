# Effect Schema HTTP

Consumer-owned HTTP contracts composed with Effect. Describe what an external service accepts and
returns, encode application values with Schema, and execute through the `@effect/platform` HttpClient
service.

This is the independent `llm2` implementation, version `0.1.0-alpha.1`. It uses Effect 3.22.2 and
Platform 0.97.2. The package is private while the design is evaluated.

## A complete operation

```ts
import { FetchHttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const Item = Schema.Struct({ id: Schema.String, quantity: Schema.NumberFromString });

const getItem = Operation.make(
  Request.get("").pipe(
    Request.baseUrl("https://catalog.example.com"),
    Request.path(Schema.String, (id, encode) => `/items/${encode(id)}`),
  ),
  Response.status(200, Response.tag("Found", Body.jsonSchema(Item))).pipe(
    Response.orElse(Response.status(404, Response.tag("Missing", Body.empty))),
  ),
);

const program = getItem.execute({ path: "item/42" }).pipe(
  Effect.map((result) => (result._tag === "Found" ? result.value.quantity : 0)),
  Effect.withSpan("inventory.quantity"),
  Effect.provide(FetchHttpClient.layer),
);

// An ordinary Effect: evaluate it with the application's runtime.
export { program };
```

Construction is pure. `execute` returns a cold Effect; running it resolves computed defaults, validates
and encodes input, obtains the supplied HttpClient, and decodes the selected response. Re-running the
same Effect performs a fresh evaluation. A required body is a required input property, so an incomplete
request cannot be passed to `execute` without a type error.

Response cases use explicit **first-match order**. Predicates receive only status, headers, and cookies.
A selected decoder's failure stays a failure. Use `Schema.Union` for payload alternatives under the same
metadata. Recognized non-2xx results can be ordinary success values, as `Missing` is above; application
code can move them into the failure channel using `Operation.mapEffect` or `Effect.flatMap`.

## Modules

Each module is available as a namespace from the package root or as a subpath, such as
`viell-effect-schema-http/Request`.

| Module        | Responsibility                                                                        |
| ------------- | ------------------------------------------------------------------------------------- |
| `Body`        | Finite JSON, text, bytes, form data, URL-encoded and empty codecs; schema composition |
| `Request`     | Pure input descriptions, deferred fields, typed encoders and argument adaptation      |
| `Response`    | Metadata-only selection, explicit alternatives and optional tagged envelopes          |
| `Operation`   | Request/response composition returning ordinary Effects                               |
| `Policy`      | Opt-in attempt retries with native Schedules and attempt deadlines                    |
| `Url`         | A replaceable Context reference for path encoding, query encoding and URL joining     |
| `Transport`   | Per-evaluation header details for providers preserving repeated physical lines        |
| `Interaction` | Scoped shared execution, automatic supersession and one retained result               |

Use native Context tags and Layers for application clients, native Config for configuration, native
logging/tracing operators, and the application's existing runtime. The library does not require a
parallel service registry. See the [service example](examples/catalog.ts),
[legacy format example](examples/legacy.ts), and [scoped search example](examples/search.ts).

## Request input and defaults

`Request.body(encoder)`, `Request.headers(schema)`, `Request.query(schema)` and
`Request.path(schema, render)` add required `body`, `headers`, `query` and `path` input properties.
Encoding validates application-side values. `Schema.NumberFromString`, for example, accepts a number
when sending and produces a number when receiving.

Headers and query parameters can instead use plain declarations:

```ts
import { Request } from "viell-effect-schema-http";

let token: string | undefined;
const common = Request.get("/search?q=initial").pipe(
  Request.baseUrl("https://catalog.example.com"),
  Request.setHeader("authorization", () => token),
  Request.setQuery("q", "current"),
  Request.appendQuery("filter", "available"),
);
const publicRequest = common.pipe(Request.removeHeader("authorization"));
export { common, publicRequest, token };
```

Removing a computed field suppresses its function entirely. Every materialization computes surviving
fields once, even when that evaluation retries. Repeated query entries remain repeated. A `null` query
value represents a bare key (`?wsdl`); an empty string represents `?wsdl=`. Request
transforms are reusable functions and preserve all other type parameters.

Selecting a schema binds that entire header or query group, replaces its raw defaults, and disables
raw setters for that group. Optional and non-record application inputs work when the selected schema
encodes them into the required wire shape. `Request.mapInput` adapts the final argument, including
application-selected default bodies. `Request.mapEffect` supports custom preparation with typed errors
and service dependencies.

## Retries and lifetime

Retries are opt-in. Supply `Policy.make(schedule, options)` as `Operation.make`'s `policy` option. The
schedule receives a `Policy.Reason`, and owns one retry budget across transport failures and response
statuses. The default classifier matches the installed Platform transient policy. Successful mapped
responses such as `503` can be retried; exhaustion returns the final attempt's actual result.

Each attempt owns a Scope and includes body decoding. Cleanup completes before the schedule delay.
`Retry-After` sets a minimum delay by default. `attemptTimeout` bounds one attempt; wrap the complete
operation in `Effect.timeout` for a total deadline. Effect interruption still waits for uninterruptible
finalizers, so a timeout is not a guarantee that cleanup finishes by the deadline.

Request materialization sits outside the attempt loop. A native `transformClient` runs per attempt and
can add service requirements or errors. Use it for signatures and nonces. An outer `Effect.retry`
re-evaluates the **whole operation**, including credentials and encoding; choose that boundary
intentionally. Replay safety belongs to the application, particularly for mutations and custom bodies.

`Interaction.make(operation.execute)` acquires an interaction in a Scope and captures its dependencies.
Changed input interrupts previous work; equal input joins active work or reuses its retained success.
`run(input, { force: true })` starts fresh work. `close` is permanent and waits for all owned finalizers.
A `retain(value, input)` predicate controls retention without changing the returned value. A waiter's
interruption leaves shared work alive. See [the detailed contract](docs/reference.md).

## Development and evidence

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:package
```

`pnpm check` runs typechecking, both linters, formatting, unit/example tests, local HTTP integration
tests, and the build. The integration tests need permission to bind an ephemeral loopback port.
`pnpm test:unit` runs without network listeners.

`pnpm check:package` builds a tarball, installs it into an isolated temporary consumer, preferring the local
pnpm store and fetching missing archives, emits declarations, and executes package-root and subpath imports. It uses matching peer
versions and never links a development checkout. Use `pnpm pack` and install the archive into other
applications; keep Effect and Platform as consumer-owned peer dependencies.

The tests cover synthetic transports, native TestClock retry timing, real Fetch uploads and cancellation,
scoped concurrency, and compiled examples. This branch has not been run through the separate browser
or full five-service evaluation applications. Focused regressions reproduce protocol edge cases identified
in `repo-llm1-test2`, including bare queries, repeated header lines and per-attempt signing. Streaming is intentionally
deferred. Core code never binds to a
runtime transport; the real HTTP tests establish behavior for the tested Node Fetch provider only.

See [design and tradeoffs](docs/design.md), [the module reference](docs/reference.md), and
[behavioral coverage](docs/coverage.md).
