/** Maps domain `Schema.TaggedError`s to an HTTP status and their own encoded JSON body, and
 * defines the small set of response shapes this "long-lived" backend actually sends: most
 * routes are JSON, but the feed endpoint sends text (XML) and the attachment/admin-stats
 * endpoints send raw bytes, matching the codecs exercised on the client in `packages/web/src/api.ts`. */
import { Effect, Schema } from "effect";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@realworld/domain";

export type DomainError = ValidationError | UnauthorizedError | ForbiddenError | NotFoundError | ConflictError;

/** Extra response header fields a handler needs beyond the content type, such as `Retry-After`. */
export type ResponseHeaders = Readonly<Record<string, string>>;

export type RouteResponse =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown; readonly headers?: ResponseHeaders }
  | {
      readonly kind: "text";
      readonly status: number;
      readonly contentType: string;
      readonly body: string;
      readonly headers?: ResponseHeaders;
    }
  | {
      readonly kind: "bytes";
      readonly status: number;
      readonly contentType: string;
      readonly body: Uint8Array;
      readonly headers?: ResponseHeaders;
    }
  | { readonly kind: "empty"; readonly status: number; readonly headers?: ResponseHeaders };

const encode = <A, I>(schema: Schema.Schema<A, I>, value: A, status: number): Effect.Effect<RouteResponse> =>
  Schema.encode(schema)(value).pipe(
    Effect.map((body): RouteResponse => ({ kind: "json", status, body })),
    Effect.orDie,
  );

/** Encodes a domain error the same way any other schema-shaped body is encoded, then wraps it
 * with the status the `repo` library's client-side `response()` rules match on. */
export const domainErrorToResponse = (error: DomainError): Effect.Effect<RouteResponse> => {
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
