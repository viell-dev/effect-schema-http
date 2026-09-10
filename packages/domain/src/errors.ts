/**
 * Domain errors, modelled as `Schema.TaggedError`s.
 *
 * Each error is simultaneously: (1) a normal Effect error channel member usable with
 * `Effect.fail`/`yield*` on the server, (2) a `Schema` that can encode itself to a JSON body,
 * and (3) the exact shape a client decodes via the `repo` library's `response()` matcher on
 * `_tag` + HTTP status. This is the same discriminated-union pattern the library's own README
 * quick-start uses for its `NotFound` response.
 */
import { Schema } from "effect";

export class ValidationError extends Schema.TaggedError<ValidationError>("ValidationError")("ValidationError", {
  message: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>("UnauthorizedError")(
  "UnauthorizedError",
  { message: Schema.String },
) {}

export class ForbiddenError extends Schema.TaggedError<ForbiddenError>("ForbiddenError")("ForbiddenError", {
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>("NotFoundError")("NotFoundError", {
  resource: Schema.String,
  id: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedError<ConflictError>("ConflictError")("ConflictError", {
  message: Schema.String,
}) {}
