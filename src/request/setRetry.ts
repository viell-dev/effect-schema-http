import { type RequestPlanTransform, type RetryPolicy } from "./types.js";

/** Pipeable form of {@link RequestPlan.setRetry}. */
export const setRetry =
  (retry: RetryPolicy | undefined): RequestPlanTransform =>
  (plan) =>
    plan.setRetry(retry);
