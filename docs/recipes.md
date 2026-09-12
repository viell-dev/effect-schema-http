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

## Creation and recoverable attachment uploads

Start with [createAttachmentWorkflow](../examples/workflows/createAttachmentWorkflow.ts) and its
[schemas and error](../examples/workflows/attachmentSchemas.ts). This example service creates a document with POST and
replaces named attachments with PUT. For this service, repeating a PUT with the same name and bytes is idempotent.
That is an explicit backend contract required for recovery, not a promise supplied by an HTTP method or the library.

Construct the workflow with a base URL. Allocate a native `Ref<UploadCheckpoint | undefined>` for one operation owner,
then execute `workflow.create(input, progress)` under the application's HttpClient. Its input contains `document:
{ title }` and `attachments: [{ name, bytes }]`. Every document field and attachment is validated before creation;
duplicate attachment names fail because this API identifies attachment resources by name. The operation snapshots bytes
at execution time so subsequent form edits do not change the upload or recovery payload. Checkpoints themselves remain
caller-owned immutable values; do not mutate their arrays or bytes.

After creation, the checkpoint records the returned document ID, completed attachment names and pending attachments.
Uploads execute sequentially in the same fiber. A successful step updates the checkpoint in a protected bookkeeping
window; the HTTP request remains interruptible. Expected upload failure becomes `AttachmentUploadFailed<E>` with the
precise underlying cause and checkpoint. The caller can inspect that error, report it once, and invoke
`workflow.resume(error.checkpoint, progress)` after a deliberate recovery decision. Resume does not create a document
or repeat completed uploads.

Interruption and defects retain their Effect meaning. Read the latest progress Ref after interruption or a defect to
recover acknowledged work. Interruption awaits the owned child's cleanup; it does not translate into an empty success
or run a detached upload. The caller decides whether to resume, abandon, or explicitly delete a partially created entity.
If creation itself fails, no successful upload phase or fabricated identifier is reported.

Use one progress Ref and one running operation per owner; these recipes do not serialize concurrent calls or make a
checkpoint durable across page reloads/process exits. A new create attempt starts a new operation and clears progress
only after its input validates. Preserve any checkpoint you intend to recover before starting another create. A
persistent checkpoint requires an application-defined byte storage and serialization contract.

A server can commit before the client receives an acknowledgement. Creation followed by a lost response therefore
cannot be made safe to retry by a local checkpoint alone; a backend idempotency key or reconciliation is needed. A
cancelled upload may likewise have reached the server, which is why this recipe's PUT replacement contract matters.
Do not apply a blanket retry to `workflow.create`, and audit retries installed in the supplied HttpClient too. Effect
cancellation does not roll back committed remote work.

Run `pnpm exec vitest run examples/workflows` for the
[executable scenarios](../examples/workflows/createAttachmentWorkflow.test.ts). They verify complete preflight
validation, create failure, checkpointed partial failure, resume without duplicate creation, structured interruption
and cleanup, and byte snapshots. Tests use an in-memory HttpClient; they do not prove a remote service implements the
required idempotency contract.
