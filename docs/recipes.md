# Application composition recipes

These executable examples build application operations from request plans, response codecs and Effect Schema.
Their endpoint paths, field names and business policies belong to the example service. Copy and adapt them into a
consumer SDK; they are not package-root exports or policies imposed on every HTTP request.

## Metadata-aware catalog responses

Start with [createCatalogClient](../examples/metadata/createCatalogClient.ts), its
[schemas](../examples/metadata/catalogSchemas.ts), and [created-ID codec](../examples/metadata/createdIdCodec.ts).
Construct the client with a base URL, then run `client.list({ offset: 0, limit: 10 })` or
`client.create({ name: "Ada" })` with an application-provided `HttpClient`. Construction sends nothing.

The list query accepts numeric application values and encodes them through a query schema. The list response maps
explicit `200` and `204` rules into `{ items, totalCount, response }`. Schema decoding validates the required
`x-total-count` header as a decimal nonnegative safe integer. Missing, malformed or overflowing values fail with
`InvalidPageMetadata`, preserving status, headers and the parse cause. Returning the envelope alongside the normalized
page keeps transport metadata available to application code. Another API can choose a different header or an optional
count without changing library behavior.

The create response uses a rule-specific codec. For this service, a valid UUID in the last `Location` path segment
identifies the created entity; query and fragment suffixes are ignored. It never follows the URL. If that segment is
absent or invalid, the codec reads JSON. The response schema validates the resulting `{ id }` in either case. A valid
header takes precedence over any body value, and the codec drains that unused body rather than leaving it unread.
This parsing convention does not normalize outgoing request URLs.

Response selection remains based on HTTP metadata. The selected codec owns the body; it may inspect metadata while
reading it, but competing rules do not probe the payload. A body-drain failure remains a failure. Custom error/service
requirements beyond the existing codec interface belong in an operation after decoding.

In a cross-origin browser, the server must expose `Location` and `x-total-count` through CORS for the client to read
them. The tests use an in-memory Platform client and do not establish browser CORS behavior.

Run `pnpm exec vitest run examples/metadata` for the
[executable scenarios](../examples/metadata/createCatalogClient.test.ts). They cover query encoding, empty pages,
malformed counts, header precedence, body consumption and identifier fallback. The default `pnpm test` includes them.

The schema boundary follows Effect's [schema decoding](https://effect.website/docs/v3/schema/basic-usage) and
[expected-error composition](https://effect.website/docs/v3/error-management/expected-errors).
