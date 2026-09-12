import { type RequestPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setRetries}. */
export const setRetries =
  (retries: number): RequestPlanTransform =>
  (plan) =>
    plan.setRetries(retries);
