# Pre-beta review

This historical review describes the pre-redesign implementation preserved by the local tag
`before-effect-native-2026-09-12`. See [design.md](design.md) for current beta.2 contracts. In particular, preserving dot
segments is now deliberate consumer policy, and field schemas, codec-only bodies and automatic gate interruption are
implemented. Historical findings and counts below should be read in that snapshot's context.

Reviewed on 2026-09-10 for Codeberg and local-tarball evaluation. This pass covered the public API, implementation,
unit and integration tests, TSDoc, examples, and build/distribution metadata. It preserved the lazy request-plan model
and avoided a retry-loop or configuration-model rewrite.

## Fixed in this pass

- Header normalization no longer crashes on object-prototype names such as `constructor` and `__proto__`.
- A synchronous throw from a gate's `execute` callback no longer leaves a stuck flight. Defects reach callers and
  subsequent requests can recover. Invalidation now clears state and signals all cancellations uninterruptibly.
- Ordinary response-rule arrays retain conservative response unions when merged or replaced. Literal tuples retain
  their existing precise replacement behavior.
- Intermediate retry responses and `ResponseBody.none` now drain streams without accumulating the entire payload.
- README, TSDoc, design notes, contributing instructions, and changelog now describe the actual beta workflow and
  execution boundaries. Registry publication is disabled with `private: true`; local packing remains available.

## Deferred findings

### 1. Dot-segment path values can change the target path

**Priority: high when path values are untrusted.** `fillPath` in [request.ts](../src/request/types.ts) uses
`encodeURIComponent`, which leaves `.` and `..` unchanged. A URL implementation then normalizes whole dot segments:
`/users/:id/profile` with `id: ".."` becomes `/profile`. This was reproduced with the local Node URL implementation.
Percent-encoding the dots is not a general solution because URL parsing also recognizes encoded dot segments.

For beta use, validate that interpolation cannot produce a whole `.` or `..` segment. A follow-up should decide whether
to reject these resulting segments with a configuration error, and test repeated/adjacent placeholders and values
inside larger segments. This changes the currently documented non-empty-string contract, so it was left as an explicit
design decision rather than adding a blanket ban on dots in values.

### 2. Retry attempts have several timeout and cleanup paths

**Priority: medium.** In `executeWithRetry`, a retryable response leaves the attempt timeout before schedule evaluation
and disposal. Disposal receives another full timeout; if the schedule stops, final decoding also receives a fresh
timeout. Disposal failures exit directly instead of re-entering retry classification. The error-retry branch can also
receive a provider `ResponseError` with a live response and wait without draining it. These are findings from
control-flow inspection; provider-error cleanup and the full timing matrix need dedicated regression coverage.

For beta use, set a whole-operation deadline with an outer `Effect.timeout`. Prefer clients that return HTTP responses
normally so this library performs status matching. A follow-up should put sending, disposal, and decoding under a
consistent attempt lifetime while preserving the primary failure and interruption semantics.

### 3. Retries reuse bodies and can replay mutations

**Priority: medium when retries are enabled.** Schema encoding and request transforms run once before
`executeWithRetry`; the same encoded request is sent again. Built-in finite bodies are suitable for ordinary replay,
but a custom codec or transform may install a one-shot stream. The retry classifier also applies to every HTTP method,
and the additional predicate cannot veto built-in transient cases.

Keep retries disabled unless the endpoint tolerates replay and its body is reusable. A future change should decide
between explicit replayability metadata, a per-attempt body factory, or a narrower retry contract. This requires API
and lifecycle design, not just changing the default retry predicate.

### 4. Immutability does not isolate mutable caller input

**Priority: medium.** Plans copy their own structural state but keep references to body values, matchers, codecs,
cache/retry policy objects, and some declaration inputs. Gate inputs, keys, and cached results are also retained by
reference. Changing those objects can change an existing plan's later execution or make gate retention disagree with
its key. Single-use header/query iterables supplied to endpoint declarations can also be exhausted across calls.

Treat declarations and retained values as immutable; use reusable collections for defaults. A follow-up can snapshot
structural configuration at declaration/setter boundaries. Cloning arbitrary domain bodies or Effect schemas should
not be implied by that change.

### 5. Some dynamic types still overstate runtime guarantees

**Priority: medium for generic application wrappers.** The array-composition bug is fixed, but the tuple helpers
`RemoveMatchingRule` and `ReplaceMatchingRule` still use tag assignability to infer runtime equality. Widened or
union-valued tags can therefore remove possible responses or omit a replacement from the inferred type. For example,
an override with `_tag: string` need not replace every inherited literal tag at runtime.

`PathArguments<string>` also describes a zero-argument endpoint even if the runtime template contains placeholders.
`InitialBodyReady` treats a possibly undefined default value as ready if its type is not entirely `undefined`, while
runtime readiness checks the actual value. These are type-definition findings; a broader compile-time regression
matrix is needed before choosing their replacement behavior.

Use literal path templates and tags, tuple rule lists, and definitely defined default bodies in the first consuming
project. Generic wrappers should retain these literals rather than widen them. A follow-up should choose conservative
types or reject unsupported dynamic declarations explicitly.

### 6. Compatibility and remote enforcement are not established

**Priority: before stronger support claims or registry publication.** The runtime metadata declares Node.js 20, but this
review runs on Node.js 22.23.1 and the configured Woodpecker image uses Node.js 24. Browser, alternative-runtime, and
official non-Fetch client coverage is absent. The repeated-header test uses a small custom provider; it does not certify
an official Node client. A local Fetch probe also dropped the unusual `__proto__` header even though it reached the
provider's normalized request correctly, reinforcing that wire preservation is a provider/runtime concern.

The repository contains a Woodpecker pipeline, but its activation and remote results were not inspected. No Codeberg
release or registry publication was performed. Decide the supported matrix, verify a packed consumer on those runtimes,
and enable/check remote CI before relying on it as a release gate.

## Open questions

The decisions needed for the findings above are recorded under
[Remaining design questions](design.md#remaining-design-questions). Streaming responses, typed request fields,
additional metadata, and API introspection remain future work rather than requirements for trying the existing
finite-body API.

## Validation

- `pnpm check` passed: 74 tests across eight files, type checking, linting, formatting, and the production build.
  The integration tests required permission to bind ephemeral loopback sockets in this environment.
- A real `pnpm pack` produced the beta archive with ESM output, declarations, source maps and sources, documentation,
  and the example; colocated tests were excluded.
- A consumer outside the repository loaded the extracted package using the existing installed Effect 3.22.2 and
  Effect Platform 0.97.2 peers. Runtime checks covered lazy construction, response decoding, gate reuse, and root and
  `package.json` exports. Its TypeScript source was checked against the packed declarations with TypeScript 6.0.3.
- A fresh offline pnpm installation could not complete because the peer tarballs were missing from the pnpm store.
  The extracted-package smoke check does not establish a clean registry-backed installation or the broader runtime
  matrix. That remains release verification work.

🤖 Generated with GPT-6 via Codex
