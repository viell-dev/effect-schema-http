import { type QueryParamValueInput, type RawQueryPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.appendUrlParam}. */
export const appendUrlParam =
  (key: string, value: QueryParamValueInput): RawQueryPlanTransform =>
  (plan) =>
    plan.appendUrlParam(key, value);
