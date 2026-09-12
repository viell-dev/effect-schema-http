import type { AnyRequestBody } from "./types.js";
import { type AnyResponseRule, type AnySchema, type RequestPlan } from "./types.js";

/** Extracts the lazy Effect from a fully configured request plan. */
export const toEffect = <
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
>(
  plan: RequestPlan<Body, Rules, BodyReady, H, Q>,
): RequestPlan<Body, Rules, BodyReady, H, Q>["effect"] => plan.effect;
