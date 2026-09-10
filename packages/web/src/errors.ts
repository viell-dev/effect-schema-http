/** Every endpoint inherits the same five domain-error response rules (see `api.ts`), so this one
 * `Match.tag`/`Match.exhaustive` chain renders any of them, no matter which endpoint returned it. */
import { Match } from "effect";

type DomainErrorEnvelope =
  | { readonly _tag: "ValidationError"; readonly body: { readonly message: string; readonly issues: ReadonlyArray<string> } }
  | { readonly _tag: "UnauthorizedError"; readonly body: { readonly message: string } }
  | { readonly _tag: "ForbiddenError"; readonly body: { readonly message: string } }
  | { readonly _tag: "NotFoundError"; readonly body: { readonly resource: string; readonly id: string } }
  | { readonly _tag: "ConflictError"; readonly body: { readonly message: string } };

const DOMAIN_ERROR_TAGS = new Set([
  "ValidationError",
  "UnauthorizedError",
  "ForbiddenError",
  "NotFoundError",
  "ConflictError",
]);

/** Returns a human-readable message if `result` is one of the shared domain errors, or
 * `undefined` if it is a success case the caller should handle itself. */
export const domainErrorMessage = (result: { readonly _tag: string; readonly body: unknown }): string | undefined => {
  if (!DOMAIN_ERROR_TAGS.has(result._tag)) return undefined;
  return Match.value(result as DomainErrorEnvelope).pipe(
    Match.tag("ValidationError", (r) => `Validation failed: ${r.body.issues.join("; ")}`),
    Match.tag("UnauthorizedError", (r) => r.body.message),
    Match.tag("ForbiddenError", (r) => r.body.message),
    Match.tag("NotFoundError", (r) => `${r.body.resource} "${r.body.id}" was not found`),
    Match.tag("ConflictError", (r) => r.body.message),
    Match.exhaustive,
  );
};
