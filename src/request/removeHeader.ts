import { type RawHeaderPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.removeHeader}. */
export function removeHeader(name: string): RawHeaderPlanTransform;

export function removeHeader(name: string, value: string): RawHeaderPlanTransform;

export function removeHeader(name: string, value?: string): RawHeaderPlanTransform {
  return (plan) => (value === undefined ? plan.removeHeader(name) : plan.removeHeader(name, value));
}
