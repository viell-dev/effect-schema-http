import { type CachePolicy, type RequestPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setCache}. */
export const setCache =
  (cache: CachePolicy | undefined): RequestPlanTransform =>
  (plan) =>
    plan.setCache(cache);
