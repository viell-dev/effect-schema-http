import { type QueryParamValue, type QueryParamValueInput, type RawQueryPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setUrlParam}. */
export function setUrlParam(key: string, value: QueryParamValueInput): RawQueryPlanTransform;

export function setUrlParam(
  key: string,
  currentValue: QueryParamValue,
  replacementValue: QueryParamValueInput,
): RawQueryPlanTransform;

export function setUrlParam(
  key: string,
  currentValue: QueryParamValueInput,
  replacementValue?: QueryParamValueInput,
): RawQueryPlanTransform {
  return (plan) =>
    replacementValue === undefined
      ? plan.setUrlParam(key, currentValue)
      : // The three-argument form selects an existing value, which only a static one can be.
        plan.setUrlParam(key, currentValue as QueryParamValue, replacementValue);
}
