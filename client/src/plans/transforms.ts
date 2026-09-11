import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { RequestPlanTransform } from "viell-effect-schema-http";

/**
 * Reusable, cross-endpoint plan setters.
 *
 * `RequestPlanTransform` is the library's own polymorphic setter type, so each of these
 * composes into any endpoint's plan regardless of that endpoint's body, rules, or
 * readiness — which matters here because the five services share almost nothing else.
 *
 * The rule these follow, taken from the previous project's conclusion: **if the safe
 * answer is "always", it belongs in the API declaration as a computed value; if the
 * caller has to choose, it belongs in a transform.** Everything in this file is a
 * caller's choice.
 */

/**
 * Bypass both the browser's HTTP cache and the reverse proxy in front of an endpoint.
 *
 * Two setters that must travel together: `setCache` speaks to the browser, and the
 * cache-busting parameter speaks to the proxy, which is old enough to ignore request
 * cache directives entirely. Forgetting either makes "refresh" silently do nothing, and
 * that is exactly why this is one named transform rather than two lines at a call site.
 *
 * The parameter is *computed* rather than fixed, so a plan retained across several
 * refreshes sends a new value each time instead of the one captured when it was built.
 */
export const forceFresh: RequestPlanTransform = (plan) =>
  plan.setCache({ control: "no-cache", fetch: "reload" }).setUrlParam("_cb", () => String(Date.now()));

/**
 * Attach one scope per `X-Scope` header field line.
 *
 * The ID server's scoped-token endpoint reads `get_all("x-scope")` and rejects a
 * comma-joined value, so the plan has to retain repeated entries rather than one
 * combined string. Whether they survive to the wire is a property of the provider, not
 * of the plan — see `src/services/repeatedHeaderClient.ts`.
 */
export const withScopeLines =
  (scopes: ReadonlyArray<string>): RequestPlanTransform =>
  (plan) =>
    scopes.reduce<ReturnType<RequestPlanTransform>>(
      (current, scope) => current.appendHeader("x-scope", scope),
      plan,
    );

/**
 * Send a monotonically increasing correlation nonce.
 *
 * Deliberately a transform taking an explicit value rather than a computed header that
 * increments a counter: a computed header resolves once per plan *evaluation*, so every
 * retry attempt would reuse the same nonce. Making the value a parameter forces the
 * caller to decide where the loop lives.
 */
export const withNonce =
  (nonce: number): RequestPlanTransform =>
  (plan) =>
    plan.setHeader("x-nonce", String(nonce));

/**
 * Tunnel a method the corporate proxy in front of the notification service refuses to
 * forward.
 *
 * The plan is still declared as the method it tunnels so the call site reads honestly;
 * the rewrite to `POST` happens in a request transform, after encoding.
 */
export const tunnelMethod =
  (method: string): RequestPlanTransform =>
  (plan) =>
    plan
      .setHeader("x-http-method-override", method.toUpperCase())
      .mapRequest((request) => HttpClientRequest.setMethod(request, "POST"));

/**
 * Turn off Effect Platform's tracer propagation for one plan.
 *
 * Two of the five services have a fixed `Access-Control-Allow-Headers` list that
 * predates distributed tracing, so a browser preflight carrying `traceparent` and `b3`
 * fails against them. Servers under our control allow the headers instead; this exists
 * for the ones that are not.
 */
export const withoutTracing: RequestPlanTransform = (plan) =>
  plan.mapClient(HttpClient.withTracerPropagation(false));
