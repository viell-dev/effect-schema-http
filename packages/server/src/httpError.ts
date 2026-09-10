/** Maps domain `Schema.TaggedError`s to an HTTP status and their own encoded JSON body. */
import { Effect, Schema } from "effect";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@realworld/domain";

export type DomainError = ValidationError | UnauthorizedError | ForbiddenError | NotFoundError | ConflictError;

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

const encode = <A, I>(schema: Schema.Schema<A, I>, value: A, status: number): Effect.Effect<JsonResponse> =>
  Schema.encode(schema)(value).pipe(
    Effect.map((body) => ({ status, body })),
    Effect.orDie,
  );

/** Encodes a domain error the same way any other schema-shaped body is encoded, then wraps it
 * with the status the `repo` library's client-side `response()` rules match on. */
export const domainErrorToResponse = (error: DomainError): Effect.Effect<JsonResponse> => {
  switch (error._tag) {
    case "ValidationError":
      return encode(ValidationError, error, 400);
    case "UnauthorizedError":
      return encode(UnauthorizedError, error, 401);
    case "ForbiddenError":
      return encode(ForbiddenError, error, 403);
    case "NotFoundError":
      return encode(NotFoundError, error, 404);
    case "ConflictError":
      return encode(ConflictError, error, 409);
  }
};
