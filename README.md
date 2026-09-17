# Effect Schema HTTP

Consumer-owned HTTP contracts composed with Effect. Describe what an external service accepts and
returns, encode application values with Schema, and execute through the `@effect/platform` HttpClient
service.

This is the independent `llm2` implementation, version `0.1.0-alpha.2`. It uses Effect 3.22.2 and
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

Response cases use explicit **first-match order**. Predicates receive only transport metadata, including headers and cookies.
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

Header schemas may encode records with string or string-array values, or ordered string pairs. Query
schemas may encode records or pairs with supported scalar/array values, including null for bare keys.
The restriction is on `Schema.Encoded`: a narrower application `Schema.Type` may use numbers, branded
values or another domain shape. Headers and queries need no schema when plain declarations suffice.
Bodies also need no schema when a built-in encoder/decoder such as `Body.bytes` already describes them.

Request declarations preserve repeated values and their cross-name order. Native Platform headers are
still available as a normalized compatibility view. Supporting providers can preserve request lines
through `Transport.headerLines` and attach observed response lines with `Transport.withResponseHeaders`.
Response metadata exposes these as `headerLines: Option<Transport.Lines>`. `None` means the provider did
not supply them; the library does not split comma-containing values or invent lost lines. Ordinary
consumers can continue using `metadata.headers` and `metadata.cookies`.

## Retries and lifetime

Retries are opt-in. Supply `Policy.make(schedule, options)` as `Operation.make`'s `policy` option. The
schedule receives a `Policy.Reason`, and owns one retry budget across transport failures and response
statuses. The default classifier matches the installed Platform transient policy. Successful mapped
responses such as `503` can be retried; exhaustion returns the final attempt's actual result.

Each attempt owns a Scope and includes body decoding. Unmatched bodies are drained, and cleanup
completes before retry classification or the schedule delay, including after decoding failure. Resourceful
decoders and client middleware receive this Scope without requiring one from the caller.
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

Unmatched responses fail with metadata-only `Response.UnexpectedStatus`. To inspect an unexpected body,
add a final response case that reads text or bytes inside the attempt and returns a finite diagnostic
value. A live response is not transferred through the error channel.

## Logging

Operations emit native Effect Debug events for attempts, retries and completion, with method, status,
attempt number and outcome category. An operation log span supplies elapsed time. Request URLs, headers,
cookies, bodies and error causes are not recorded by these events. Enable them with
`Logger.withMinimumLogLevel(LogLevel.Debug)` or a native Logger layer; formatting, destinations and
correlation remain application-owned. No library-specific logging option is required.

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
scoped concurrency, preserved header lines in both directions, typed repeated fields, and compiled examples.
The separate [five-service evaluation](../repo-llm2-test1/README.md) runs the unchanged Rust, Python, Java,
Perl and Ruby services through an adapted client, including Node tests and a Chromium saga/cancellation
check. Its README records the exact vendored revision and verification results. Adapted expectations are
called out there; this is application evidence, not a claim of complete llm1 feature parity.

Streaming is intentionally deferred. Core code never binds to a runtime transport. Provider behavior
still needs verification for the runtime and transport selected by the consumer.

See [design and tradeoffs](docs/design.md), [the module reference](docs/reference.md), and
[behavioral coverage](docs/coverage.md).
