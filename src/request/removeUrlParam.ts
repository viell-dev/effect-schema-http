import { type QueryParamValue, type RawQueryPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.removeUrlParam}. */
export function removeUrlParam(key: string): RawQueryPlanTransform;

export function removeUrlParam(key: string, value: QueryParamValue): RawQueryPlanTransform;

export function removeUrlParam(key: string, value?: QueryParamValue): RawQueryPlanTransform {
  return (plan) => (value === undefined ? plan.removeUrlParam(key) : plan.removeUrlParam(key, value));
}
