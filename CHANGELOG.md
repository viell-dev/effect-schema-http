# Changelog

All notable changes to this project will be documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Preparing `0.1.0-beta.1` for Codeberg and local-tarball evaluation; no release has been tagged yet.

### Fixed

- Header normalization handles names such as `constructor` and `__proto__` without object-prototype collisions.
- Request gates recover after synchronous request-construction defects and signal invalidation atomically.
- Non-tuple response-rule arrays retain conservative success unions through composition and replacement.
- No-body and intermediate retry responses are discarded without buffering their entire payloads.

### Changed

- Documented local beta consumption, execution boundaries, body ownership, and gate semantics.
- Marked the repository private until registry publication is planned; recorded deferred review findings and questions.

### Added

- Lazy, immutable, pipeable HTTP request plans backed by Effect Platform `HttpClient`.
- Schema-based request encoding and tag-discriminated response decoding.
- API defaults, sub-API extension, path parameters, and call-site overrides.
- JSON, text, byte, form-data, and explicit no-body response codecs.
- Retry schedules, timeouts, cache controls, response matching, and repeated-field support.
- Single-entry request gates with in-flight de-duplication, refresh, reload, and interruption.
- Unit, type-level, and loopback-server integration test coverage.
- ESM package metadata, MIT licensing, release checks, and a Node.js 20 runtime baseline.
