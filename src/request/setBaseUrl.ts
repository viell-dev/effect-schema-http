import { type RequestPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setBaseUrl}. */
export const setBaseUrl =
  (baseUrl: string | undefined): RequestPlanTransform =>
  (plan) =>
    plan.setBaseUrl(baseUrl);
