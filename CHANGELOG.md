# Changelog

All notable changes to this project will be documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0-beta.2 (unreleased)

- Added SchemaHttp and UrlEncoding services/layers with shared request defaults and replaceable encoding policy.
- Added optional complete-collection header/query schemas, typed encoding failures and propagated schema requirements.
- Added codec-only request and response bodies, preserving schema validation when a schema is selected.
- Simplified interaction gates to run/force/dispose with automatic supersession, current-flight retention and awaited cleanup.
- Preserved empty path strings and dot segments; dynamic path maps and optional-default readiness are conservative.
- Split source into category modules without index barrels, preserved portable root declarations, and cleaned stale build output.
- Added opt-in diagnostics through native Effect logging; updated packed Node/web consumers and documentation.

The annotated local tag `before-effect-native-2026-09-12` preserves the pre-redesign beta.1 commit; it is not a published release.

## 0.1.0-beta.1 (historical local evaluation)

Prepared for Codeberg and local-tarball evaluation before the redesign.

### Fixed

- Header normalization handles names such as `constructor` and `__proto__` without object-prototype collisions.
- Request gates recover after synchronous request-construction defects and signal invalidation atomically.
- Non-tuple response-rule arrays retain conservative success unions through composition and replacement.
- No-body and intermediate retry responses are discarded without buffering their entire payloads.

### Changed

- Documented that a request body codec owns the content type and replaces a declared `content-type` header.
- Documented how to discriminate a response body from a service that does not transmit a discriminant.
- Documented `mapClient` as the seam for values derived from the encoded request, such as a body signature.
- Documented that repeated response header field lines are also provider-dependent, and browser-impossible.
- Documented that redirect, cookie, and credential behavior belong to the provider, and that following a redirect makes a `3xx` response rule unreachable.
- Documented why the beta must be installed as a packed tarball rather than linked from a checkout.
- Documented local beta consumption, execution boundaries, body ownership, and gate semantics.
- Documented the schema each body codec pairs with, backed by a typechecked example and runtime coverage.
- Documented the Fetch client's `traceparent`/`b3` propagation, its CORS consequences, and how to disable it.
- Marked the repository private until registry publication is planned; recorded deferred review findings and questions.

### Added

- Server-backed coverage of conventions from services this library does not control: codec-owned content types,
  `Retry-After` as an HTTP-date, an unregistered status outside the transient set, an arbitrary method with a `207`,
  an untagged error payload, and a signature computed from the encoded body.
- Lazy, immutable, pipeable HTTP request plans backed by Effect Platform `HttpClient`.
- Schema-based request encoding and tag-discriminated response decoding.
- API defaults, sub-API extension, path parameters, and call-site overrides.
- `RequestPlanTransform`, the public type for plan setters shared across endpoints.
- Computed header and query-parameter values (`() => value | undefined`) resolved when a request is
  materialized, so live application state can drive declared defaults and `undefined` omits the field.
- JSON, text, byte, form-data, and explicit no-body response codecs.
- Retry schedules, timeouts, cache controls, response matching, and repeated-field support.
- Single-entry request gates with in-flight de-duplication, refresh, reload, cancellation, and invalidation.
- Unit, type-level, and loopback-server integration test coverage, including URL fragment handling.
- ESM package metadata, MIT licensing, release checks, and a Node.js 20 runtime baseline.
