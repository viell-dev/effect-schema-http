import { Effect, ParseResult, Schema } from "effect";
import { ValidationError } from "@realworld/domain";

/** Decodes an unknown JSON value against a schema, turning a `ParseError` into the domain
 * `ValidationError` the client-facing error union expects instead of a defect. */
export const decodeBody = <A, I>(schema: Schema.Schema<A, I>, value: unknown): Effect.Effect<A, ValidationError> =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(
      (parseError) =>
        new ValidationError({
          message: "request body failed validation",
          issues: ParseResult.ArrayFormatter.formatErrorSync(parseError).map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          ),
        }),
    ),
  );
