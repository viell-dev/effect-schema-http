# Effect HTTP contracts against five unchanged services

This is the `llm2-test1` worktree, branched from `llm1-test2` at `d3f011e`. It adapts the
TypeScript client to the independently designed [llm2 library](../repo-llm2). The Rust,
Python, Java, Perl, and Ruby services are unchanged, as are their launch scripts.

The client consumes `viell-effect-schema-http@0.1.0-alpha.2` from a packed archive built
from library commit `45a8069`. It uses that library directly: there is no llm1 dependency
or compatibility implementation. This evaluation also verifies alpha.2’s representation
preservation with a provider that exposes individual header lines.

## Verification

Verified locally on 2026-09-17 with Node 22.23.2:

- **138 tests pass**, with all five services available and no skipped tests. These include
  the original 135 cases adapted to llm2 contracts, a per-attempt nonce case, and two
  additional cases for schema-encoded request headers and observed response lines.
- Consumer TypeScript checking and the Vite production build pass.
- The Chromium smoke script exercises registration, both login representations, header-only
  responses, cache bypass, repeated-header rejection through Fetch, retry/nonce behavior,
  Java writes, SOAP 1.1/1.2, WebDAV, bare query keys, multipart uploads/downloads, XML-RPC,
  signed notifications, and the five-service reconciliation saga.
- With 250 ms browser network latency, replacing an active search produces
  `net::ERR_ABORTED`; the retained result for the final input renders. Navigating away
  closes the mounted interaction's scope, and returning creates a fresh interaction.

The Node provider test separately confirms that two physical `X-Scope` lines reach Rust
and succeed, including through a schema accepting an array of values. It also preserves
four separate response fields from Rust’s token probe. Fetch combines those fields;
its metadata explicitly reports that original lines are unavailable.

## Running it

Use Node 22 or newer and pnpm 10. The backend toolchains are Rust/Cargo, Python 3, Java
with the checked-in Gradle wrapper, Perl, and Ruby with WEBrick. See the service source
and [original evaluation](EVALUATION-LLM1.md#running-it) for backend details.

```sh
pnpm install --frozen-lockfile
bash scripts/start-all.sh
```

In another terminal:

```sh
pnpm typecheck
REQUIRE_SERVICES=1 pnpm test
pnpm build:client
CHROMIUM_PATH=/usr/bin/chromium pnpm --filter client test:browser
```

`test:browser` uses Playwright's installed Chromium when `CHROMIUM_PATH` is omitted.
It requires Vite on `http://localhost:5173` and all five backends. `CLIENT_URL` overrides
that frontend URL. The ordinary Vitest command allows service-dependent suites to skip
when the servers are absent; `REQUIRE_SERVICES=1` makes missing services a failure.

Only one copy of the five-service testbed can use the default ports at a time:

| Service            | Port | Wire contracts exercised                                                     |
| ------------------ | ---- | ---------------------------------------------------------------------------- |
| Rust identity      | 4100 | JSON/form grants, query authentication, HEAD, nonce replay, repeated headers |
| Python files       | 4200 | SOAP 1.1/1.2, Latin-1 XML, WebDAV, bytes, multipart, bare query keys         |
| Java business API  | 4300 | JSON, OData, lossless integer parsing, conditional writes, method tunneling  |
| Perl reporting     | 4400 | XML-RPC, HTTP Digest, fixed-width Latin-1, CSV, header-discriminated errors  |
| Ruby notifications | 4500 | HMAC, CSRF, XSSI, JSONP, redirects, long polling, status 420                 |

## Client structure

- `src/schemas/` describes each wire format and its translation to domain values. The
  schemas' behavior is unchanged; comments now refer to llm2's codec names.
- `src/services/` composes `Request`, `Body`, `Response`, and `Operation`. Small application
  options apply reusable raw request transformations before schema binding and native
  `HttpClient` transformations per attempt.
- `src/plans/` contains request transformations and native signing middleware. The folder
  name is inherited from the testbed; it does not contain a request-plan implementation.
- `src/integration/` contains the translation layer, compensation saga, and scoped
  `Interaction` over Java search and Perl's extract.
- `src/ui/` owns rendered state, mounted scopes, and user actions. The shared
  `ManagedRuntime` provides Fetch, logging, and configuration.

For example, a complete body is supplied at execution time, and retry policy is an
explicit operation choice:

```ts
import { Schedule } from "effect";
import { Policy } from "viell-effect-schema-http";
import { withNonce } from "./client/src/plans/transforms.js";
import { sessionEcho } from "./client/src/services/idClient.js";

const request = sessionEcho({
  request: withNonce(1000),
  policy: Policy.make(Schedule.recurs(3)),
}).execute({ body: { message: "replay the same encoded request" } });
```

The Effect is cold. A declared nonce resolves once per evaluation, so that example
intentionally receives a replay rejection after the initial 503. The additional test
uses `HttpClient.mapRequestEffect` to advance the nonce **per attempt**, preserving the
library's retry budget and `Retry-After` handling. No manual loop is required for that case.

## Semantic adaptations

Response values use `{ _tag, value, metadata }`. `Response.orElse` makes precedence
explicit: specific endpoint cases precede shared fallbacks. There is no automatic
specificity ranking, and several cases may use the same tag.

`Request.body` requires a complete typed input when executing an operation. Invalid
schema inputs fail with the native `ParseError`; failed response decoding is wrapped in
`Response.DecodeError`. An unmatched response is drained and fails with
`Response.UnexpectedStatus`. Diagnostic payloads are read by an explicit fallback
**inside the operation scope**. The tests cover reading and discarding there; they do
not attempt to keep a live response after its transport scope has closed.

Retries are opt-in through `Policy.make`. A custom classifier replaces the default, so
the 420 example explicitly combines `Policy.transient(reason)` with its additional
status. `Effect.timeout` bounds the whole operation; `Policy.attemptTimeout` is available
for a timeout per attempt.

Bare query keys use `null`, empty values use `""`, and repeated fields use append
combinators. The WSDL test confirms that the Python service observes `?wsdl` and `?wsdl=`
as different requests. A custom Node provider reads `Transport.headerLines(request)`
when physical repeated request headers matter and attaches observed response lines with
`Transport.withResponseHeaders`. Response metadata includes native headers and cookies
alongside `headerLines: Option<Transport.Lines>`. Fetch supplies `None`; the custom Node
provider supplies `Some` without splitting or reconstructing comma-separated values.

Interactions are acquired inside a `Scope`. Equivalent terms join or reuse retained
success, new terms replace active work, and force executes again. The browser closes
its scope on navigation. Updating a credential changes the header display without
unmounting the action or scope that produced it, so signing in during the saga does
not discard the eventual result.

## Browser transport configuration

Java's client disables tracing propagation because that service's CORS allowlist rejects
trace headers. Ruby's WEBrick automatically answers `OPTIONS` without its application's
CORS headers. Its notification operations need a preflight, so the browser client uses
Vite's **same-origin proxy** for Ruby's existing paths. No Ruby code changes are needed,
and preserving the paths keeps the HMAC request line identical at both ends.

Node tests still call Ruby directly. Vite's development and preview servers both have
the proxy. A separately hosted production build must provide equivalent routing, or
set `VITE_NOTIFY_SERVER_URL` to a browser-accessible gateway. The other service base URLs
can also be set with their `VITE_*_SERVER_URL` variables.

Fetch still controls redirects, cookies, cache modes, and header normalization. A
`Request` description cannot override browser restrictions. The refresh action combines
`Cache-Control`, a computed cache-busting query parameter, and the native
`FetchHttpClient.RequestInit` cache option. Browser JavaScript cannot inspect
`Set-Cookie`; Node's Fetch does not maintain a cookie jar automatically.

## Provenance

[The original llm1 evaluation](EVALUATION-LLM1.md) is preserved verbatim as historical
material. Its version claims, API names, limitations, and earlier verification results
refer to llm1, not this client or the llm2 library.

The service boundary can be checked directly:

```sh
git diff llm1-test2 -- services scripts
```

That diff is empty. [Vendor provenance](vendor/README.md) identifies the exact packed
library consumed by this worktree.
