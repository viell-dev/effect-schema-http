import type { RequestPlanTransform } from "viell-effect-schema-http";
import { getSession } from "./session.js";

/**
 * Call-site override attaching the current session's bearer token.
 *
 * `RequestPlanTransform` is the library's public type for a plan setter that preserves a plan's
 * typestate, which is what makes one helper usable across endpoints whose `Body`, `Rules`, and
 * `BodyReady` parameters all differ — annotating against a concrete `RequestPlan<...>` instead
 * would pin this to a single endpoint. Because the transform returns the same plan type it was
 * given, `withAuth(createPost()).setBody(...)` still typechecks the body against that endpoint's
 * schema, and `plan.pipe(withAuth)` composes with any other setter.
 */
export const withAuth: RequestPlanTransform = (plan) => {
  const session = getSession();
  return session ? plan.setHeader("authorization", `Bearer ${session.token}`) : plan;
};
