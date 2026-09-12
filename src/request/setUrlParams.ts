import { type QueryParamsInput, type RawQueryPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setUrlParams}. */
export const setUrlParams =
  (params: QueryParamsInput): RawQueryPlanTransform =>
  (plan) =>
    plan.setUrlParams(params);
