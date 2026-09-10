import { getSession } from "./session.js";

/** Call-site override attaching the current session's bearer token, the same "exceptional API
 * calls are local and composable" pattern the library's README demonstrates with `setUrlParam`
 * and `setCache` — every setter returns another plan, so this composes with anything else the
 * caller does to the same plan. */
export const withAuth = <Plan extends { readonly setHeader: (name: string, value: string) => Plan }>(
  plan: Plan,
): Plan => {
  const session = getSession();
  return session ? plan.setHeader("authorization", `Bearer ${session.token}`) : plan;
};
