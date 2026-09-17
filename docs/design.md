# Design

This implementation targets Effect 3.22.2 and Effect Platform 0.97.2. Installed peer sources are the
primary reference for integration details. It is a consumer-side contract library for finite HTTP exchanges.

## Boundaries

- `Body` separates outgoing encoders from incoming decoders. Schemas compose at these boundaries;
  neither direction requires a schema. Custom formats use ordinary functions returning Effects.
- `Response` selects a decoder from status, headers, and cookies alone. Cases compose in explicit
  first-match order. Once selected, a decoder failure cannot fall through to another case.
- `Request` describes input preparation and declarative defaults. Required input is represented by
  the function argument type, rather than an executable object with partially initialized body state.
- `Operation` pairs a request with a response contract. Invocation is a cold Effect. Schema services,
  transport services, and custom preparation requirements remain in its environment type.
- `Policy` adds attempt retries using native schedules. Materialization occurs outside that loop;
  an ordinary `Effect.retry` around the complete operation deliberately materializes again.
- `Transport` supplies repeated request header lines through a per-evaluation Context reference.
  Supporting providers can preserve them without attaching a parallel request object to Platform.
- `Interaction` owns shared work in a Scope. New input interrupts old work; equal input joins it or
  reuses the one retained success. Presentation state remains the application's responsibility.

Consumers compose common request transforms, response contracts, and native Layers. No API registry,
custom runtime, logging facility, or configuration provider is necessary. URL encoding is replaceable.

Finite-body execution owns one scope per attempt. Intermediate and unrecognized bodies are drained
without buffering; Platform's scoped client also releases the transport on decoding failure or
interruption. Streaming is deferred because it requires a different lifetime and sharing contract.

## References

- [Effect Platform HttpClient](https://effect.website/docs/v3/api/platform/HttpClient)
- [Effect Schema](https://effect.website/docs/v3/schema/introduction)

The implementation verifies behavior against the installed peers and local tests; these reference links
explain upstream abstractions, not a compatibility claim for arbitrary versions or transports.

## Provider boundaries

Request descriptions distinguish bare query keys, empty values and repeated header lines. Preserve
those distinctions even when a default execution service normalizes them. The provider documentation
explains what survives on the wire; an ordinary consumer can use default HTTP behavior without
configuring or learning these extension points. A consumer whose service needs a distinction can select
an appropriate provider while keeping the same request contract.

## Field representations

Keep the representations the library knows. Repeated header lines, comma-containing values, bare query
keys, empty values, and cross-name entry order are not interchangeable. Native HttpClient middleware still
receives Platform's normalized headers; the original request lines remain available to supporting providers.
Provider-observed response lines are optional metadata with explicit availability, alongside the normal
lookup view. No normalization policy switch is needed for this boundary.

Schemas are optional validation and transformation at that boundary. Their application type can be a domain
value; their encoded type must fit the selected representation. Header arrays and ordered pairs are supported
without joining them in the preserved representation. Standalone strings do not implicitly become whole
field collections. Bodies similarly require an encoder/decoder, but not necessarily a schema: bytes and
FormData already have useful runtime representations.
