import type { AnyRequestBody, RequestBodyValue } from "./types.js";
import { type AnyResponseRule, type AnySchema, type RequestPlan } from "./types.js";

/** Pipeable form of {@link RequestPlan.setBody}. */
export const setBody =
  <Value>(body: Value) =>
  <
    Body extends AnyRequestBody,
    Rules extends ReadonlyArray<AnyResponseRule>,
    BodyReady extends boolean,
    H extends AnySchema | undefined = undefined,
    Q extends AnySchema | undefined = undefined,
  >(
    plan: Value extends RequestBodyValue<Body> ? RequestPlan<Body, Rules, BodyReady, H, Q> : never,
  ): RequestPlan<Body, Rules, true, H, Q> =>
    plan.setBody(body as RequestBodyValue<Body>);
