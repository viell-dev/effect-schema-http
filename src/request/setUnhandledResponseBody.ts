import { type RequestPlanTransform, type UnhandledResponseBodyPolicy } from "./types.js";

/** Pipeable form of {@link RequestPlan.setUnhandledResponseBody}. */
export const setUnhandledResponseBody =
  (policy: UnhandledResponseBodyPolicy): RequestPlanTransform =>
  (plan) =>
    plan.setUnhandledResponseBody(policy);
