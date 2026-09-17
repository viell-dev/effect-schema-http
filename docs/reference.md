# Module reference

Public namespace exports live in [`src/main.ts`](../src/main.ts). All examples in
[`examples/`](../examples/) are typechecked; the example test suite also executes them with synthetic
transports. Library functions never call `runPromise` or create an application runtime.

## Body

`Encoder<A, E, R>` converts an application value into a Platform `HttpBody`. `Decoder<A, E, R>` converts
a finite Platform response into a value. `Codec<A, EncodeError, DecodeError, EncodeContext, DecodeContext>`
combines them while keeping the two error and dependency channels distinct.

| Export             | Contract                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| `encoder`          | Construct an encoder from an Effect-returning function                         |
| `decoder`          | Construct a decoder; optional media type contributes to automatic Accept       |
| `make`             | Combine encode/decode functions and optional media type                        |
| `json`             | Unknown JSON values; empty or malformed input is a decoding failure            |
| `text`             | UTF-8 string representation                                                    |
| `bytes`            | Finite Uint8Array representation                                               |
| `formData`         | Platform FormData encoding/decoding; the transport owns the multipart boundary |
| `urlEncoded`       | Platform UrlParams entries                                                     |
| `empty`            | No outgoing body; drain incoming bytes without buffering                       |
| `jsonSchema`       | Bidirectional Schema validation over JSON                                      |
| `schema`           | Pipeable incoming schema decoding over any decoder                             |
| `encodeSchema`     | Compose outgoing Schema encoding with an encoder                               |
| `map`, `mapEffect` | Transform a decoded value, preserving or extending errors and requirements     |

`schema` and `map` produce decoders, not bidirectional codecs. Outgoing input must follow the selected
encoder's schema; there is no alternate raw-body input through that contract. For a custom protocol,
use `Body.make` or separate directions. The [fixed-width example](../examples/legacy.ts) shows a
representation that has no relationship to JSON.

Codecs supply outgoing content type through `HttpBody`; a body encoder can replace a default
Content-Type. Multipart deliberately delegates its boundary to the transport. An explicit Accept
header wins over the union of declared response media types. Schemas can be contextful in both directions.

## Request

`Request<I, E, R, H, Q>` is a pipeable, pure description. `I` is the complete application input. `H` and
`Q` track whether schemas own headers and query respectively. `make(method, url)`, `get(url)` and
`post(url)` create descriptions with no required input; execute them with `undefined`.

| Combinator                                  | Effect on the description                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `baseUrl`                                   | Replace the base URL used at materialization                                       |
| `setHeader`, `appendHeader`, `removeHeader` | Edit unbound header declarations; names are case-insensitive                       |
| `setQuery`, `appendQuery`, `removeQuery`    | Edit unbound query declarations, preserving repeated entries                       |
| `headers(schema)`                           | Require `{ headers: A }`; encode to string-valued fields                           |
| `query(schema)`                             | Require `{ query: A }`; encode to Url.QueryInput                                   |
| `path(schema, render)`                      | Require `{ path: A }`; render the encoded input with the supplied path encoder     |
| `body(encoder)`                             | Require `{ body: A }`; encode before execution                                     |
| `mapInput(f)`                               | Adapt the invocation argument, including defaults and domain-specific input shapes |
| `mapEffect(f)`                              | Effectful preparation with the current request and input                           |
| `compile(description, input)`               | Produce a request plus repeated-header details for custom execution                |
| `materialize(description, input)`           | Explicitly produce a Platform request without sending it                           |

Raw header values are strings or `() => string | undefined`. Raw query values additionally accept
`null`, which means a bare key; `undefined` returned by a computation means omission. Set replaces all entries of a
name; append
retains them. Remove without a value removes the whole name. Remove with a string removes matching
static entries only, never evaluating a computed entry to test it. Repeated headers have a normalized
comma-separated representation and retain their original lines for supporting providers through `Transport`.

Schemas replace the entire raw group. Compose repeated typed query values through an encoded array. Query schemas can
encode to `Url.QueryInput`: a record or iterable
of pairs with scalar/array string, number, boolean, null, or undefined values. Null represents a bare
key and undefined is omitted; nested query structures need explicit encoded bracket keys.
Header schemas encode to records of strings or undefined; undefined fields are omitted. The original
application shape need not be a record. Applying the same input binding twice intersects its input types;
construct an alternative description when replacing a schema with a different contract.

Descriptions share application input values rather than deep-cloning mutable objects. Treat those values
as immutable while an execution uses them. Declaration edits copy their maps and never mutate earlier
descriptions. The `prepare` and `options` members are low-level extension points; ordinary consumers
should use the combinators.

GET and HEAD bodies are rejected during materialization. Other methods, including custom strings, pass
to the supplied transport, whose method support may differ. Path renderers can express embedded
parameters and arbitrary legacy layouts without adopting a placeholder grammar.

## Url

`Url.Url` is a native Context reference with built-in defaults. `Url.layer(service)` replaces the same
interface through ordinary Layer composition. The service has `path`, `query`, and `join` functions.

Defaults percent-encode path values and query entries, preserve repeated keys, and join a base and
relative path at their slash boundary. An absolute operation URL overrides the base. They do not
canonicalize dot segments or reject empty values. The final provider can still normalize a URL; a
provider using the web URL implementation cannot promise literal dot-segment transport semantics.

Raw query strings in a declared URL are decoded at construction and participate in the same subsequent
edits as other query defaults. Schema-selected query groups replace those entries. URL encoding runs
after input preparation. A custom `mapEffect` may intentionally construct its own representation, but
assumes responsibility for that policy.

## Transport

Platform's Headers representation combines duplicate names. `Transport.HeaderLines` is a native Context
reference carrying the lossless request entries for one evaluation. Operation supplies it automatically.
A provider calls `yield* Transport.headerLines(request)` after its native request transformations to
recover unchanged repeated fields. Changed or removed normalized fields take precedence; tracing and
signing headers therefore survive. `Transport.reconcile` exposes that field-by-field reconciliation
as a pure function. Replacing a header with exactly the same combined text is indistinguishable from
leaving it unchanged; explicitly supply a different HeaderLines context to force that case to collapse.

`Request.compile` returns `{ request, headerLines }` for applications executing Platform requests
themselves; provide `Transport.HeaderLines` around that execution. The simpler `materialize` returns
only the normalized Platform request. Neither operation sends a request.

Fetch continues to combine repeated header lines. A Node provider that reads the context can preserve
them on the wire; both behaviors have loopback tests. Response header normalization remains
provider-owned; metadata uses Platform Headers and Cookies and cannot reconstruct discarded lines.

Provider settings remain ordinary Effect composition. For Fetch, supply
`FetchHttpClient.RequestInit` with `redirect: "manual"`, `credentials: "include"`, or `cache: "reload"`
where appropriate. A default Fetch provider follows redirects before response selection, and Node
Fetch has no implicit cookie jar. `HttpClient.withTracerPropagation(false)` is available as a native
client transform for services whose browser CORS allowlists reject tracing headers. These mechanisms
are provider configuration, not additional operation policy fields.

## Response

`Response<A, E, R>` selects a `Body.Decoder` from `Metadata`: status, Platform Headers and Cookies.
`when(predicate, decoder)` constructs a case; `status(number, decoder)` is the exact-status convenience.
`first.pipe(orElse(second))` gives the first case priority, with no specificity scoring or hidden
replacement. The decoder is selected before its body is accessed. Use separate values to express
alternative priorities.

`tag(name, decoder)` produces `{ _tag: name, value, metadata }`; it is optional. Arbitrary domain types,
including Schema-tagged classes, can be returned directly. `decode(contract, response)` performs
selection and decoding and can be used with an independently obtained Platform response.

An unmatched response is drained, then fails with `UnexpectedStatus { metadata }`. A reader or schema
failure becomes `DecodeError<E> { metadata, cause }`, preserving the selected decoder's typed cause.
A failed drain is also a DecodeError. Defects and interruption retain their native Effect meaning.
For service-specific unknown-response recovery, declare a final `Response.when(() => true, decoder)`
that consumes the needed body inside the attempt's lifetime. A raw stream cannot safely escape an
operation's finite-body scope.

## Operation and Policy

`make(request, response, options?)` returns `Operation<I, A, E, R>`. `execute(input)` is cold and reusable;
`Operation.execute(operation, input)` also supports data-last use. `fromEffect` adapts an existing
Effect-returning function. `map` and `mapEffect` compose domain interpretation after HTTP execution.

The environment includes HttpClient and every input/decoder/client-transform/schedule requirement.
Input schema ParseErrors and custom preparation errors are preserved. Transport failures are native
HttpClient errors. Response failures carry metadata as described above. A timeout is a native
TimeoutException. The static operation error union includes TimeoutException even when no attempt
timeout was selected, so policy configuration does not change the invocation shape.

Materialization occurs once per evaluation. The attempt loop then:

1. Applies the optional native client transform, creates a fresh Platform request identity, and executes
   a scoped client.
2. Selects a response case and consumes/decodes its finite body, inside the optional attempt timeout.
3. Awaits cleanup and inspects the outcome. Interruption and defects never retry.
4. Classifies a resource-free `Policy.Reason`. Native failure causes and available metadata are retained.
5. Advances one Schedule driver. Exhaustion returns the attempt result unchanged; otherwise it observes
   the schedule delay and any remaining Retry-After minimum before the next attempt.

Successful intermediate responses are decoded before retry classification. This lets the loop release
all response resources before sleeping, but can perform schema work that a later attempt replaces.
Requests whose decoding can hang should specify an attempt timeout. Credential computation and request
encoding sit outside that timeout; use a total `Effect.timeout` when those phases also need a deadline.

`Policy.none` performs one attempt. `Policy.make(schedule, { while, attemptTimeout, retryAfter })` opts
into retries. The default classifier handles transport failures, timeouts, and statuses 408, 429, 500,
502, 503 and 504. Supply `while` to replace that choice. Compose schedules with native `Schedule`
operators for counts, backoff, jitter and service-dependent policies. Retry-After accepts seconds or an
HTTP date; malformed/nonfinite values impose no extra delay. Disable it with `retryAfter: false`.

Use ordinary request headers for HTTP cache hints. This library does not implement a protocol cache.
Avoid accidentally combining multiple retry owners; a client transform containing its own retries has
its own budget. Custom request bodies must be replayable when retries are enabled.

## Interaction

`make(execute, { equivalence?, retain? })` is a scoped acquisition. It captures services at acquisition
and gives each underlying execution its own child scope. The default equivalence is `Equal.equals`:
plain objects compare by identity; Effect Data values can provide structural equality. Use an explicit
equivalence for application input records. Include account/locale/authorization context when it changes
what a retained value means.

| Event                             | Behavior                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Ordinary equal active input       | Join its Deferred                                                                       |
| Different input                   | Interrupt the previous worker and start new work, or reuse the matching retained result |
| Ordinary retained input           | Reuse the single retained successful value                                              |
| Forced input                      | Interrupt any current worker and execute, bypassing retention                           |
| One waiter interrupted            | Leave shared work alive                                                                 |
| Current successful execution      | Evaluate `retain` once; retain by default                                               |
| Excluded current success          | Return it; clear an equivalent retained key, preserve an unrelated one                  |
| Failure, defect, interruption     | Preserve retained data                                                                  |
| Superseded completion             | Cannot change retention                                                                 |
| `close` or acquisition scope ends | Reject future work and await every owned finalizer, including superseded workers        |

A short semaphore-protected state transition admits callers and publishes completions; it never holds
the semaphore while waiting for user work or finalizers. Workers belong to a dedicated Scope and
publish an Exit through Deferred. A retention-predicate defect still clears active state and releases
all shared callers. Concurrent `close` callers share completion.

Retained values are application data, not live scoped resources. A new request can begin while an old
uninterruptible finalizer is completing; closure waits for both. Cancellation cannot roll back a remote
mutation. Application presentation state still needs stale-result protection and a lifecycle owner.
Streaming and shared stream lifetime remain deliberately outside this interface.
