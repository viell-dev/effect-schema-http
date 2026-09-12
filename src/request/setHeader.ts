import { type HeaderValueInput, type RawHeaderPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setHeader}. */
export function setHeader(name: string, value: HeaderValueInput): RawHeaderPlanTransform;

export function setHeader(
  name: string,
  currentValue: string,
  replacementValue: HeaderValueInput,
): RawHeaderPlanTransform;

export function setHeader(
  name: string,
  currentValue: HeaderValueInput,
  replacementValue?: HeaderValueInput,
): RawHeaderPlanTransform {
  return (plan) =>
    replacementValue === undefined
      ? plan.setHeader(name, currentValue)
      : // The three-argument form selects an existing value, which only a static one can be.
        plan.setHeader(name, currentValue as string, replacementValue);
}
