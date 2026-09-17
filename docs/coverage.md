# Behavioral coverage

The design preserves the consumer capabilities established in the workspace while expressing their
composition independently. These are implementation and test claims for this branch, not results from
the separate evaluation applications.

| Capability                                   | Mechanism / evidence                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Cold definitions and repeatable execution    | Request descriptions and ordinary Effects; `Operation.test.ts`                           |
| Deferred removable header/query defaults     | Immutable ordered declarations, materialized before attempts; `Operation.test.ts`        |
| Bare and empty query values                  | Explicit null flag, empty string and schema-encoded flags; legacy and wire tests         |
| Repeated physical request header lines       | Context reference plus a supporting Node provider; compared with Fetch on the wire       |
| Typed path, header, query and body input     | Schema encoders and required input intersections; runtime and negative compile checks    |
| Typed body readiness and default input       | Required argument properties; `Request.mapInput` composes defaults                       |
| Alternate response envelopes and domain data | Ordered metadata-only cases, tagged values, Schema unions, Effect mapping                |
| JSON / text / bytes / multipart / form data  | Independent encoders/decoders; body and real Fetch tests                                 |
| Legacy representations                       | Custom codec plus Schema; executable fixed-width example                                 |
| Schemas with services                        | Environment propagation; contextful schema test and compiled declarations                |
| Shared client defaults and application APIs  | Reusable Request transforms, Context tags and Layers; executable Catalog example         |
| URL policy replacement                       | Context reference and Layer; custom encoding test                                        |
| Retry budget, classification and deadlines   | Native Schedule driver, Clock, Effect timeout; synthetic and TestClock tests             |
| Per-attempt signatures / nonces              | Native client transforms with preserved error/environment channels                       |
| Explicit response ownership                  | Per-attempt scopes, draining, real Fetch interruption and abort-signal assertions        |
| Response metadata and cookies                | Platform lookup headers/cookies plus optional provider lines; header and real wire tests |
| Native diagnostics                           | Debug events and log spans; level filtering and absence of payload data tested           |
| HTTP cache hints                             | Ordinary headers; actual caching remains provider-owned                                  |
| Interaction sharing and supersession         | Scope-owned workers, Deferred publication and semaphore transitions; interaction tests   |
| Retention eligibility and predicate defects  | Typed predicate with guaranteed publication; interaction tests                           |
| Awaited permanent disposal                   | Dedicated ownership scope and shared close completion; blocked-finalizer tests           |
| Peer identity and distribution               | Tarball installed into an independent consumer, declaration emit and runtime smoke test  |

The numbered report elsewhere in the workspace describes the other implementation and is not this
branch's API documentation. This branch's reference is [reference.md](reference.md).

## Verification boundaries

The suite runs against Effect 3.22.2 and Platform 0.97.2. Its real HTTP tests use Node's Fetch provider
and ephemeral loopback servers. Examples execute without external services. Package verification uses
an archive and independently installed peers, not a linked source checkout.

The separate [repo-llm2-test1 evaluation](../../repo-llm2-test1/README.md) executes an adapted client
against the unchanged Rust, Python, Java, Perl and Ruby services. It includes Node tests, Chromium
execution of the cross-service saga, and observed cancellation with added browser network latency.
Its README and vendor provenance identify the tested library revision. Tests of deliberately changed
contracts (such as response ownership) were adapted and are not evidence of identical llm1 semantics.

No Bun runtime or complete provider matrix has been tested. Streaming is deferred, and a retry policy
cannot establish idempotency or remote rollback.

## Polyglot edge-case review

The `repo-llm1-test2` README and current client tests informed additional focused regressions in
`Legacy.test.ts` and `Network.test.ts`. They exercise bare WSDL keys, unchanged repeated header lines,
HMAC over schema-encoded bytes with fresh attempt nonces, custom 420 retry classification, header-based
errors under HTTP 200, payload unions, Latin-1 bytes, SOAP content-type ownership, method tunneling,
PROPFIND construction, large integer decoding, HEAD metadata, empty 200/304 responses, and redirects.

The focused tests use independent fixtures. The separate application evaluation also exercises polling,
Digest challenge/re-execution and saga compensation as application Effects. Header tests now include
schema-encoded repeated values and ordered pairs, arbitrary application types, concurrent preparation,
and provider-supplied response lines. Ownership regressions block an intermediate finalizer and verify
that decoding/draining and cleanup complete before classification or a subsequent attempt.
