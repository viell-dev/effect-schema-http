import { type HeaderValueInput, type RawHeaderPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.appendHeader}. */
export const appendHeader =
  (name: string, value: HeaderValueInput): RawHeaderPlanTransform =>
  (plan) =>
    plan.appendHeader(name, value);
