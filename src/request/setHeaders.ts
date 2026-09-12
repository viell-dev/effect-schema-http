import { type HeaderInput, type RawHeaderPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setHeaders}. */
export const setHeaders =
  (headers: HeaderInput): RawHeaderPlanTransform =>
  (plan) =>
    plan.setHeaders(headers);
