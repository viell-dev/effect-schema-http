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
