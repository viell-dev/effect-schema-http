/**
 * Opt in to bypassing every cache between this app and the database, for one call.
 *
 * Two caches sit in the way of the feed and the Atom feeds, and each needs a different lever:
 *
 * - The **browser's own HTTP cache**, because the reverse proxy in front of the API answers those
 *   routes with `Cache-Control: public, max-age=10`. `setCache` handles this: `control` writes the
 *   request's `Cache-Control` field for anything on the wire that respects it, and `fetch` sets
 *   Fetch's own `cache` mode, which is what actually makes the browser skip its cache.
 * - The **reverse proxy itself**, which ignores request cache directives entirely — it predates
 *   them (see `packages/server/src/edgeCache.ts`). The only thing that gets past it is a query
 *   string it has not seen, so this appends a throwaway parameter. It is computed rather than
 *   static so that each evaluation of the plan gets its own value; a fixed one would be cached on
 *   first use and never bypass anything again.
 *
 * Both levers have to travel together or the refresh silently does nothing, which is exactly the
 * kind of thing that should be named once rather than remembered at four call sites. It is typed
 * with the library's `RawQueryPlanTransform` so it applies to any endpoint's plan regardless of
 * that endpoint's body, response rules, or body typestate — `listFeed` returns JSON and
 * `getBlogFeed` returns parsed XML, and this composes with both.
 *
 * This is deliberately *opt-in*: normal navigation should hit the caches, because that is what
 * they are for. Only an explicit "refresh" gesture from the reader justifies going around them.
 * (Contrast `authorization` in `api.ts`, which is a computed API-wide default precisely because
 * it should apply unless a declaration says otherwise.)
 */
import type { RawQueryPlanTransform } from "viell-effect-schema-http";

export const forceFresh: RawQueryPlanTransform = (plan) =>
  plan.setCache({ control: "no-cache", fetch: "reload" }).setUrlParam("_", () => String(Date.now()));

/** Reads the proxy's own response fields, which it exposes to this origin. */
export const describeCacheStatus = (headers: Readonly<Record<string, string>>): string => {
  const status = headers["x-cache"];
  if (status === undefined) return "not cached";
  const age = headers["age"];
  return status === "HIT" ? `served by the edge cache (age ${age ?? "?"}s)` : "fresh from the origin";
};
