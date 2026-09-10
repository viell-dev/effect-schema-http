# Review report

A design and implementation review of `viell-effect-schema-http` at commit `ea5f3ab`, covering `src/request.ts`
(1074 lines), `src/requestGate.ts` (168 lines), the export surface in `src/main.ts`, the test suite, and the claims made
in [`README.md`](../README.md) and [`design.md`](design.md). Remediation notes in §3 track subsequent fixes on
`sketch-request-builder`; the current suite has 51 tests across six files.

Baseline on entry: `pnpm test` passes (43 tests across 5 files), `pnpm typecheck` is clean. Every finding below was
verified with a throwaway probe (type-level probes read back through deliberate `TS2322` assignment errors, runtime
probes through temporary Vitest files); all probe files were removed afterwards and the working tree is unmodified.

---

## 1. Verdict

This is a strong spike. The central bet — an endpoint defined once, immutable plans per call site, a discriminated
envelope union keyed by a user-chosen string, and a cold `Effect` that is only assembled on `.effect` — is well chosen
and consistently executed. The type-level machinery (`MergeResponseRules`, `SetResponseRule`, `PathArguments`,
`UniqueResponseRules`) is unusually disciplined for a first pass, and the doc is honest about what is deferred.

The confirmed defects were concentrated in three places and have since been fixed in §3:

1. **Type/runtime disagreements.** Four places where the types promise something the runtime does not deliver, one of
   which (`R = unknown`) makes a whole class of endpoints unusable.
2. **URL construction.** `joinUrl` and the query-string handling have silent-corruption modes.
3. **Escape hatches around the typestate.** The `never`-typed `.effect` is a bottom type, so the body typestate is
   bypassable without a diagnostic.

None of these are architectural; all are fixable within the current design.

---

## 2. The good

### 2.1 The lazy plan model holds up

Plans are genuinely immutable and cold. Every combinator calls `makePlan` with a fresh `PlanState`
(`src/request.ts:820`), and nothing in the builder path touches `HttpClient`. Sharing one plan's `.effect` across
concurrent fibers sends independent requests (probed: two concurrent evaluations of one shared effect ⇒ two fetches),
which is exactly what the doc promises and what makes the request-gate layer coherent rather than redundant.

The decision to make reuse an _explicit_ layer (`makeRequestGate`) instead of a hidden property of a plan is the single
best design call in the library. It keeps `RequestPlan` a pure description and lets the stateful part carry its own
`Effect` lifetime.

### 2.2 The response envelope is the right shape

Keying the union on a user-supplied `key` rather than on status is what makes several statuses per key, and several keys
per status, both expressible. `key`/`status`/`matched` redundancy is justified in the doc and pays off: `Match.when({ key
})` narrows the body without a custom guard, and `matched` is genuinely useful when the matcher is a predicate.

Not retaining the `HttpClientResponse` in a mapped envelope is correct: the body has already been consumed, and a
replayable-looking handle that is not replayable would be worse than no handle. The asymmetry — `UnhandledResponse`
keeps the live response, mapped envelopes do not — is the right call, and it is documented.

### 2.3 Response-rule inheritance and replacement

`MergeResponseRules` / `RemoveMatchingRule` correctly implement "replace by key, keep everything else", at both type and
value level, and the ordering is stable and tested (`src/request.test.ts:341`). The thin-object case the doc calls out
works: replacing the `200` schema removes the original `200` body type from the union while inherited `404`/`410`
envelopes survive.

`UniqueResponseRules` emitting `{ "Duplicate response key": "same" }` as the failure type is a nice touch — the
duplicate key appears verbatim in the compiler message.

### 2.4 Context and error tracking through schemas

Schema requirements propagate correctly for the non-degenerate cases. A request with two response schemas carrying
different `Context.Tag` requirements types as `HttpClient | ServiceA | ServiceB`, and a context-carrying request body
schema contributes `ServiceB` to `R` through `BodyContextOf`. `ResponseDecodingError<Rules>` correctly drops
`ResponseDecodeError` from the error channel when there are no rules to decode against. This is more care than most
schema-HTTP wrappers take.

### 2.5 The codec split

Separating _schema encoding_ from _wire encoding_ is right, and the type constraint that a codec's `Input` must match
`Schema.Encoded<Body>` is what makes it safe: the caller still hands over the ordinary domain value. The
`RequestBody.text("application/xml")` + `Schema.transform` example in the tests is the strongest evidence that the
abstraction earns its place — a schema owns XML serialisation without the library knowing about XML.

`CodecOptions` refusing `ResponseBody.none` unless `undefined extends Schema.Encoded<S>` is a small, precise constraint
that prevents a whole family of declarations that could only ever fail at runtime.

### 2.6 The post-transform body guard

Checking `request.body._tag !== "Empty"` for GET/HEAD _after_ `mapRequest` transforms (`src/request.ts:845`) rather than
only at declaration time is the correct layering: the type-level `Uppercase<Method> extends "GET" | "HEAD"` guard is
defeated by a non-literal method or by `mapRequest`, and the runtime check catches both. Probed: a plan that sets a body
and then `mapRequest(setMethod("GET"))` fails with `RequestBodyNotAllowed` before the transport is touched.

### 2.7 Request-gate concurrency

The gate's state machine is careful in ways that are easy to get wrong:

- `Effect.uninterruptibleMask` with `restore` around both the execution and the `Deferred.await` means an interrupted
  waiter cannot corrupt gate state.
- Generation numbers prevent an older-started request from overwriting a newer success, and `invalidatedThrough` stops
  a flight that was in progress at `invalidate` time from repopulating the cache.
- Failures never evict the last success — the "invalid form state must not clear the table" requirement is met and
  tested.

The tests cover the interesting interleavings (stale completion, invalidation mid-flight, interrupted executor,
same-key coalescing) with `Deferred`-based determinism rather than timing, which is the right way to test this.

### 2.8 Retry draining

Draining intermediate transient responses (`yield* raw.arrayBuffer` in the retry loop, `src/request.ts:700`) is a real
improvement over `HttpClient.retryTransient`, which leaves each retried response's body unread. This is the strongest
justification for hand-rolling the response-retry loop, and the test asserting `bodyUsed` on all three intermediate
responses is exactly the right assertion.

---

## 3. Confirmed defects

Ordered by severity.

### 3.1 ~~An endpoint with no response rules types as `R = unknown` and cannot be run~~ — fixed

**Severity: high — makes a documented usage shape unusable and poisons composition.**

```ts
const ping = createRequest({ method: "GET", path: "https://x.test/y" });
// Effect<never, UnhandledResponse | ..., unknown>
//                                        ^^^^^^^ not HttpClient
```

Probed both with `responses` omitted and with `responses: []`; both yield `R = unknown`. Because `unknown` is not
`HttpClient`, `Effect.provide(FetchHttpClient.layer)` cannot discharge it, and any `Effect.gen` that yields such an
effect inherits an unsatisfiable requirement. The error channel is unaffected — only `R` is poisoned.

Root cause (`src/request.ts:217`):

```ts
type ResponseContextOf<Rules extends ReadonlyArray<AnyResponseRule>> =
  Rules[number] extends ResponseRule<ResponseMatcher, infer S, ResponseBodyCodecOrDefault>
    ? Schema.Schema.Context<S>
    : never;
```

For `Rules = readonly []`, `Rules[number]` is `never`. `never extends X` is vacuously true, `S` is inferred as
`unknown`, and `Schema.Schema.Context<unknown>` collapses to `unknown`, which then absorbs `HttpClient` in the union.

Fixed by mirroring the pattern already used correctly by `EnvelopeOfRule` — distributing over a naked type parameter, so
`never` distributes to `never`:

```ts
type ContextOfRule<Rule> =
  Rule extends ResponseRule<ResponseMatcher, infer S, ResponseBodyCodecOrDefault> ? Schema.Schema.Context<S> : never;

type ResponseContextOf<Rules extends ReadonlyArray<AnyResponseRule>> = ContextOfRule<Rules[number]>;
```

Empty rules now type as `HttpClient`, while context-carrying rules continue to contribute their schema requirements. A
zero-rule regression assertion now sits beside the complete Effect-signature test.

A regression test belongs alongside the existing "exposes the complete success, error, and requirement types" test —
that test only covers the single-rule case, which is why this slipped through.

### 3.2 ~~Exact header matchers lie about the envelope's header keys~~ — fixed

**Severity: high — a type assertion that is false at runtime.**

```ts
response({ key: "ok", status: 200, headers: { "Content-Type": "application/json" } }, User);
// envelope.headers["Content-Type"] types as "application/json"
// envelope.headers["Content-Type"] is undefined at runtime
```

`ExactMatchedHeaders` (`src/request.ts:190`) preserves the matcher's key _as written_. `@effect/platform`'s
`Headers.fromInput` lowercases every key (`Headers.js:69`), and the envelope's `headers` field is `raw.headers`
verbatim. Probed: `Object.keys(result.headers)` contains `content-type`; `result.headers["Content-Type"]` is
`undefined`.

Matching itself is fine — `matches` lowercases the matcher name before lookup (`src/request.ts:741`). Only the reflected
type is wrong.

Two viable fixes:

- Lowercase in the type: `{ readonly [K in keyof M as M[K] extends string ? Lowercase<K & string> : never]: M[K] }`.
  Cheap, and it makes the type match reality.
- Or reject non-lowercase matcher keys at the type level, so the declaration site is the thing that has to change.

`ExactMatchedHeaders` now lowercases exact matcher keys in the reflected envelope type, matching the platform's
canonical runtime representation.

### 3.3 ~~Path placeholders whose name starts with a digit are accepted by the type and rejected at runtime~~ — fixed

**Severity: medium — a compiling call that always throws.**

```ts
const endpoint = createRequest({ method: "GET", path: "https://x.test/v:1x/users", responses: [...] });
endpoint("2"); // type-checks; throws InvalidPathArguments { expected: 0, received: 1 }
```

`PathParameterCharacter` includes `` `${number}` `` and `TakePathParameter` applies it uniformly to every character
including the first, so `:1x` is a one-character-or-more parameter name at the type level. The runtime pattern
`/(?<!\\):([A-Za-z_][A-Za-z0-9_]*)/g` requires a leading `[A-Za-z_]`, so it sees no placeholder at all. The type demands
one argument; the runtime demands zero.

The type-level parser now uses a separate `PathParameterStartCharacter`, matching the runtime grammar. `/v:1/api` is
therefore a literal path at both levels, while digits remain valid after the first placeholder character.

### 3.4 ~~The body typestate is bypassable without a diagnostic~~ — fixed

**Severity: medium — silent wrong behaviour, not just a missing error.**

`RequestPlan["effect"]` is `never` when `BodyReady` is `false`. `never` is a bottom type: it is assignable to every
parameter, so it flows into any function that accepts an `Effect` with no complaint.

```ts
const incomplete = createUser(); // body schema declared, setBody not called
await Effect.runPromise(Effect.provide(incomplete.effect, layer)); // compiles, sends POST with an empty body
```

Probed: the request is sent, the body is `""`, and the plan resolves normally to `{ key: "ok" }`. The protection only
bites in the two places where `never` is structurally rejected — `yield*` inside `Effect.gen` ("Type 'never' must have a
'[Symbol.iterator](<>)' method") and `.pipe(...)` ("Property 'pipe' does not exist on type 'never'"). Both messages are
also poor: neither mentions the body.

A branded sentinel is strictly better than `never` here, because it is not assignable to `Effect`:

```ts
readonly effect: BodyReady extends true
  ? Effect.Effect<...>
  : { readonly _tag: "RequestBodyRequired"; readonly reason: "Call setBody before reading effect" };
```

That produces a diagnostic at every use site, and the diagnostic names the problem. It also fixes `toEffect`, which
currently returns `never` and therefore silently type-checks in the same way.

Incomplete plans now expose `RequestBodyRequired` instead of `never`, so they are not assignable to Effect APIs and the
compiler diagnostic identifies the missing step. The runtime value is a failed Effect carrying the same tagged error,
which prevents an untyped or degraded caller from sending an empty body.

### 3.5 ~~`joinUrl` corrupts absolute paths declared under an API base URL~~ — fixed

**Severity: medium.**

```ts
createApi("https://a.test").createRequest({ method: "GET", path: "https://b.test/users" });
// requests https://a.test/https://b.test/users
```

`joinUrl` (`src/request.ts:715`) is pure string concatenation with no absolute-URL check. The mixed style is easy to
reach: `createRequest` used standalone _requires_ absolute paths, so moving an endpoint under an API (or copying one
that was written standalone) silently produces a nonsense URL rather than an error. `setBaseUrl` on a plan has the same
hazard in reverse.

Detect an absolute path (`/^[a-z][a-z0-9+.-]*:\/\//i`, or just `URL.canParse(path)`) and either ignore the base URL or
fail loudly. Failing is probably better: silently ignoring a configured base URL is its own surprise.

`joinUrl` now rejects an absolute endpoint path when a base URL is present. Prefix joining remains unchanged and is
documented as a deliberate departure from WHATWG URL resolution semantics.

### 3.6 ~~A query string baked into a path cannot be overridden and silently duplicates~~ — fixed

**Severity: medium.**

```ts
const endpoint = api.createRequest({ method: "GET", path: "/users?active=1", ... });
endpoint().setUrlParam("active", "0");
// requests https://x.test/users?active=1&active=0
```

`HttpClientRequest.setUrlParams` sets the request's `urlParams` field; the transport appends those to whatever query
string is already present in the URL string. So path-declared parameters are invisible to `setUrlParam`,
`setUrlParams`, `removeUrlParam`, and `appendUrlParam`, and collisions become repeated parameters.

Endpoint calls now extract the declared query string into library-owned query state after filling path placeholders.
API defaults, declared path values, endpoint options, and plan setters then apply in that order. Repeated values and URL
fragments are preserved. Query values distinguish `true` (bare `key`) from `""` (`key=`) without passing through
`URLSearchParams`, which would normalize both forms.

### 3.7 ~~Replacing an existing response key silently changes tie-break precedence~~ — fixed

**Severity: low–medium — a documented rule that does not hold in one case.**

```ts
responses: [response({ key: "first", status: 200 }, S), response({ key: "second", status: 200 }, S)];
// endpoint()                                              -> key "first"
// endpoint().setResponseSchema({ key: "second", ... }, S)  -> key "second"
```

`setResponseRule` unconditionally prepends (`src/request.ts:755`). The doc says "A plan rule with a **new** key is
prepended, so it wins an equally specific tie" — but the same prepend happens for an existing key, so overriding a
rule's schema also promotes it above its equally-specific siblings. Probed and confirmed.

Runtime and type-level replacement now preserve the existing key's position. A genuinely new plan rule is still
prepended and therefore wins an equally specific tie.

### 3.8 ~~The retry budget multiplies when transport errors and transient responses alternate~~ — fixed

**Severity: low–medium — the doc's stated bound is wrong for mixed failures.**

Probed with `setRetry({ times: 2, schedule: Schedule.recurs(2) })` against a handler alternating a thrown transport
error and a `503`: **6 requests** were sent. The doc's "a mapped 503 with `times: 3` is returned after at most four
attempts" holds only when failures are homogeneous.

`executeWithRetry` (`src/request.ts:675`) composes two independent retry mechanisms with two independent schedule
drivers and two independent counters: `HttpClient.retryTransient(..., { mode: "errors-only", times })` wrapped inside a
manual response-retry loop that also counts to `times`. The worst case is `(times + 1)²` attempts. Backoff also resets:
each mechanism drives its own `Schedule.driver`, so an alternating failure pattern never accumulates delay.

Worth noting for fairness: `HttpClient.retryTransient` with `mode: "both"` nests `Effect.repeat` inside `Effect.retry`
with the same `times` and has the same multiplication property, so this is inherited from upstream rather than invented
here. But this library both re-implements the loop _and_ documents a specific bound, so it owns the discrepancy.

Retry handling now uses one loop, one counter, and one schedule driver for errors and responses. `times` is therefore a
single shared retry budget, and intermediate transient responses are still drained before the next attempt.

### 3.9 ~~Per-attempt timeouts do not cover response body reading~~ — fixed

**Severity: low–medium — the guarantee is narrower than it reads.**

```ts
endpoint().setTimeout("20 millis"); // response headers arrive fast, body streams for 120ms
```

Probed: the effect **succeeds** after ~120 ms. `Effect.timeout` is applied through
`HttpClient.transformResponse` (`src/request.ts:855`), which wraps the effect producing the `HttpClientResponse` — that
resolves when headers are available. Body reading happens later, in `decodeResponse`, outside the timeout. A server that
sends headers promptly and then stalls the body is unbounded.

The timeout now wraps transport execution and final response decoding as one attempt. Slow response bodies therefore
fail with `TimeoutException`, which participates in the same retry budget when error retries are enabled.

### 3.10 ~~`defaultBody` accepts excess properties and reports failures badly~~ — fixed

**Severity: low.**

```ts
createRequest({
  body: Schema.Struct({ action: Schema.String }),
  defaultBody: { action: "a", nope: true }, // accepted — no excess property check
  ...
});
```

`setBody` correctly rejects the same object ("Object literal may only specify known properties, and 'nope' does not
exist"), because it flows through a plain parameter. `defaultBody` is validated by a conditional type
(`DefaultBody extends Schema.Schema.Type<Body> ? DefaultBody : never`), which is an assignability check and does not
trigger excess property checking. The extra key is silently dropped by the schema at encode time.

Previously, when `defaultBody` genuinely did not match, the diagnostic was:

> Type `{ action: number; }` is not assignable to type `undefined`.

`defaultBody` now uses an exact assignability check against the schema type. Excess object-literal properties and field
type mismatches point at the supplied value rather than collapsing the property type to optional `undefined`.

### 3.11 ~~Validation errors are thrown synchronously as `Data.TaggedError`~~ — fixed

**Severity: low — a consistency and idiom issue, not a correctness one.**

`InvalidPathArguments` (from `fillPath`, on every endpoint call), `InvalidRetryCount` (from `normalizeRetry`, on
`setRetries` and on endpoint construction), and `DuplicateResponseKey` (from `validateUniqueResponseKeys`) are all
`Data.TaggedError` subclasses that are `throw`n from ordinary functions. They can never reach an Effect error channel,
so their tagged-ness buys nothing — callers must `try`/`catch` them, and `Effect.catchTag` will never see them.

The implementation now takes the first of the two coherent positions identified by the review:

- These are **defects** (programmer errors surfaced by degraded or untyped calls). `InvalidPathArguments`,
  `InvalidRetryCount`, and `DuplicateResponseKey` are now ordinary `Error` subclasses. The design document explicitly
  states that they are synchronous configuration defects rather than members of an Effect error channel.

---

## 4. Design choices worth revisiting

These are not defects; they are places where the design has taken a position that deserves an explicit decision.

### 4.1 Path arguments are unnamed, untyped strings

`PathArguments<Path>` produces `readonly [value: string, value: string]` — every element labelled `value`, every element
typed `string`. So:

```ts
const getUserPost = createRequest({ path: "/users/:userId/posts/:postId", ... });
getUserPost(postId, userId); // compiles
```

The type machinery already computes the parameter _name_ in `TakePathParameter`, then discards it, because TypeScript
cannot compute tuple element labels from a generic string. That is a genuine language limitation, not an oversight —
but the consequence is that the most common path-building mistake (transposed identifiers) is undetectable, and editors
show `value: string, value: string` in signature help.

Options, roughly in increasing order of disruption:

- Accept `string | Brand.Branded<string, any>` per position, so branded id types at least fail on transposition. Cheap,
  opt-in, no API change.
- Add an object-argument form (`getUserPost({ userId, postId })`), derivable from the same `PathArguments` machinery as
  a mapped type with real keys, offered alongside the positional form.
- Accept per-parameter schemas in the definition, which also gives encoding control beyond `encodeURIComponent`.

The second is the one that actually solves it, and it composes with `mapEndpoint` unchanged.

### 4.2 Exact status matchers do not beat predicate matchers

`specificity` counts only header matchers (`src/request.ts:753`), so within one declaration:

```ts
responses: [
  response({ key: "server-error", status: (s) => s >= 500 }, S),
  response({ key: "unavailable", status: 503 }, S),
];
// a 503 selects "server-error"
```

Probed and confirmed. This follows the documented "first equally specific rule wins", but the ordering dependency is
invisible at the call site, and a range rule inherited from the API will shadow every exact endpoint rule it covers
unless the endpoint rule is also declared — which it is, since endpoint rules are merged ahead of API rules. So the
footgun is mostly _within_ a single declaration list.

Ranking exact status above predicate status (a second specificity dimension, e.g. `headers.length * 2 + (exact ? 1 :
0)`) would make the common case do what people expect, and would make `matched` more informative rather than less.

### 4.3 The response-retry loop re-implements a platform feature

`HttpClient.retryTransient` already supports `mode: "both"` and `mode: "response-only"`, and — relevant to the doc's
open question #2 — takes a `while: Predicate<E>` for custom classification. The library re-implements the response half
(justifiably, to drain intermediate bodies) but as a result:

- duplicates `isTransientResponseStatus`, which must now be kept in sync with upstream's `isTransientResponse`;
- has no equivalent of `while`, so custom classification has no seam short of `mapClient`;
- has the budget/backoff issues in §3.8.

The narrowest good answer to open question #2 is: expose `RetryPolicy.while?: (input: RetryInput) => boolean`, feed it
to `retryTransient`'s `while` for the error dimension and to the loop's condition for the response dimension. That keeps
classification declarative and in one place, and does not require a plugin story.

Also missing from the retry story: `Retry-After` is never honoured, even though `429` and `503` are both classified as
transient and both routinely carry it. That is the single highest-value addition to `RetryPolicy`.

### 4.4 Default response readers are restricted to `json | text`, but per-rule codecs are open

`RequestOptions.responseCodec` is typed `DefaultResponseBodyCodec = typeof ResponseBody.json | typeof ResponseBody.text`,
while `response(..., { codec })` accepts any `ResponseBodyCodec`. So a user who writes a custom codec (the interface is
exported, so this is clearly intended) can use it per rule but cannot make it the default at API, endpoint, or plan
scope. Probed: passing a custom codec as `responseCodec` is a type error.

Excluding `ResponseBody.none` from the default slot is sensible — a default that discards every body would be a
footgun. But the restriction is currently expressed as an allowlist of two concrete values rather than as "any codec
except `none`", which also excludes every future built-in. `Exclude<AnyResponseBodyCodec, { name: "none" }>` or a
codec-level `canBeDefault` marker would express the intent without freezing the set.

### 4.5 No `Accept` header is ever sent

Probed: a JSON-schema-driven GET sends no `Accept` header at all. For a library whose default response codec is JSON,
that leaves content negotiation entirely to the server's default — and servers that negotiate will often return HTML or
XML. Deriving `Accept` from the effective response codec (`json` ⇒ `application/json`, `text` ⇒ `text/*`), overridable
by an explicit header exactly like `Cache-Control` already is, would be a small, high-value default.

### 4.6 Empty bodies under the JSON codec decode as `null`, not as a failure

`HttpClientResponse.json` maps an empty body to `null` rather than failing. So a `204` matched by a rule whose schema
accepts `null` succeeds without `ResponseBody.none`, while the same rule with `Schema.Void` fails with a
`ResponseDecodeError` that points at the schema rather than at the missing body. Not wrong, but it means
`ResponseBody.none` is an ergonomics feature rather than a correctness requirement, and the doc's framing ("drains the
incoming body and then decodes `undefined`") suggests otherwise. Worth one sentence.

### 4.7 `api.extend` cannot change the base URL

`extend` re-uses the parent's `baseUrl` unconditionally. Version-prefixed sub-APIs (`/v1` → `/v2`), regional hosts, and
staging mirrors are exactly what a sub-API is for, and the only current escape is a per-plan `setBaseUrl`, which has to
be repeated at every call site. Adding an optional `baseUrl` to `ApiOptions` (or an `extend(baseUrl?, options)` overload)
costs nothing and closes an obvious gap.

Relatedly, endpoint definitions can only _add_ headers and query parameters to API defaults; there is no way to remove
an inherited one at endpoint scope (only per-plan, via `removeHeader`/`removeUrlParam`). An endpoint that must not send
the API's `authorization` header has no declarative option.

### 4.8 A fresh `Effect` is constructed for every intermediate plan

`makePlan` builds `Effect.gen(...)` eagerly (`src/request.ts:821`), so a five-step combinator chain allocates six
generator-backed Effects, five of which are discarded. Probed: six distinct objects. This is invisible in correctness
terms and small in absolute terms, but it is trivially avoidable by making `effect` a getter, and it matters for the
gate/loop patterns the README advertises, where plans are rebuilt per keystroke.

A getter would also let §3.4's runtime check live at the point where `.effect` is actually read.

### 4.9 Unhandled response bodies are never drained

Probed: after `UnhandledResponse`, `response.bodyUsed` is `false`. This is documented and deliberate — ownership
transfers to the caller — but it is worth being explicit that the consequence in Node is a leaked `undici` connection
for every caller who logs the error and moves on, which is the overwhelmingly common recovery path. `HttpClient` here
carries no `Scope`, so nothing will clean it up.

Consider either draining by default with an opt-in (`UnhandledResponse` currently offers `status` and `headers`
getters, which is what most recovery code actually wants), or providing a `discard` helper on the error so the correct
thing is one call away and appears in the doc example.

### 4.10 Gate semantics that are correct but sharp

- **`invalidate` drops in-flight de-duplication.** It clears `inFlight` wholesale, so a `run` issued after `invalidate`
  while a request is still executing starts a _second_ execution (probed: two calls). Defensible — invalidation should
  not hand back a result computed from pre-invalidation state — but it is not in the doc, and it means `invalidate`
  can double the load on a hot key.
- **Single-entry retention.** Alternating between two keys re-executes every time (probed: four calls for
  `a, b, a, b`). Documented, but the README example (`key: (userId) => userId`) is precisely the shape where a user
  will assume per-key memoisation.
- **Interruption of the executing fiber completes all waiters as interrupted.** Documented, and the correct default —
  but it means a UI that cancels one component's request cancels it for every component that joined the same key.

None require changes; all three deserve a sentence in the doc, because each is the kind of thing found the hard way.

---

## 5. Remaining test coverage gaps

The suite is well constructed — three genuinely different layers, deterministic concurrency tests, real loopback
servers for integration. The §3 remediation added coverage for zero-rule requirements, canonical envelope header keys,
absolute paths under API bases, declared query strings and base path prefixes, mixed retry failures, slow response
bodies, rule replacement ordering, incomplete-body runtime protection, and `defaultBody` diagnostics. The remaining
gaps are:

1. **Concurrency of one plan.** Nothing asserts that a single plan evaluated concurrently sends independent requests —
   the core "cold and repeatable" claim is only tested sequentially.
2. **Interruption of a plan's effect** mid-flight, and what happens to the response body.
3. **Type-level negative tests for path arity.** `@ts-expect-error` on `getUserPost(a)` and `getUserPost(a, b, c)` would
   pin the `PathArguments` contract; only the runtime arity check is tested.

---

## 6. Packaging and repository hygiene

- **No licence.** `package.json` has no `license` field and there is no `LICENSE` file. For a package whose README opens
  with `pnpm add`, this is the most consequential piece of missing metadata: without it the package is legally
  all-rights-reserved.
- **No `repository`, `homepage`, or `bugs`** in `package.json`, and `keywords` is empty. `description` is present.
- **No CI configuration.** `AGENTS.md` lists the five commands that must pass before committing; nothing enforces them.
- **No `exports` entry for `./package.json`**, which some tooling probes.
- **`tsconfig.json` omits `noUncheckedIndexedAccess`** even though the code is written as if it were on
  (`pathArguments[argumentIndex++]!`, `inFlight[index]` with an `undefined` guard, `requests[0]?.url` in tests). Turning
  it on would make those defensive patterns load-bearing rather than decorative. `exactOptionalPropertyTypes` is
  similarly absent and would matter for the `setCache(undefined)` / `setTimeout(undefined)` clearing semantics.
- **Export surface.** `PathArguments` is not exported, so users cannot compute an endpoint's argument tuple; the
  `AnyResponseRule`-shaped type used throughout the public generics is not exported either, which makes user-written
  helper types over rule arrays awkward. Both are cheap to add.
- **`main` + `types` alongside `exports`** is fine for compatibility; no action needed.

---

## 7. Open questions

Restating the doc's two, and adding the ones this review raises.

**From `design.md`:**

1. _Which response codecs follow JSON, text, and no-body?_ Bytes (`Uint8Array`) is the obvious next one and is
   symmetric with `RequestBody.uint8Array`. Streaming is the one that changes the model rather than extending it: a
   streaming body cannot be replayed, cannot be shared through a request gate, and needs a `Scope` in `R` — so it should
   probably be a separate plan terminal (`.stream` alongside `.effect`) rather than a codec.
2. _Should custom retry classification be part of `RetryPolicy`?_ Yes — see §4.3. `HttpClient.retryTransient` already
   takes a `while` predicate, so the seam exists; not exposing it means `mapClient` is the only route, and `mapClient`
   cannot see the library's own response-retry loop.

**Raised here:**

3. **Are validation failures defects or failures?** Answered in §3.11: path arity, duplicate keys, and invalid retry
   counts are synchronous configuration defects represented by ordinary `Error` subclasses.
4. **Should the body typestate be enforced at runtime, not only in types?** Answered in §3.4: yes; degraded callers
   receive `RequestBodyRequired` before transport execution.
5. **Should the envelope expose response metadata beyond headers?** `matched` explains the rule; nothing exposes the
   request that produced the response, redirect history, cookies, or timing. `HttpClientResponse` carries `cookies` and
   `request`; dropping all of it may be more than the "not safely replayable" argument requires.
6. **Should query parameters and headers get schema support?** The doc defers this. The decision has a deadline: once
   `setUrlParam(key, value)` is public and stringly typed, adding a typed surface later means two parallel APIs.
7. **What is the story for content negotiation?** (§4.5) `Accept` today, `Content-Type`-driven response codec selection
   tomorrow — a rule could pick its codec from the response's content type rather than from a declaration.
8. **Should `Api` expose its resolved options?** Only `baseUrl` is readable. Testing, debugging, and building tooling
   over an API definition all want the merged headers, response rules, and policies.

---

## 8. Recommended order of work

The original §3 remediation sequence is complete. Remaining work starts outside the scope of this pass:

1. Add a licence, a `repository` field, and CI running the five commands from `AGENTS.md`.
2. Then discuss the §4 design choices: `Retry-After`, `Accept`, `extend(baseUrl)`, `RetryPolicy.while`, and the named-path
   argument question (§4.1), which is the largest open API decision remaining.
