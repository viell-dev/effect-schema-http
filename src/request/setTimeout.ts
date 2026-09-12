import { Duration } from "effect";
import { type RequestPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setTimeout}. */
export const setTimeout =
  (timeout: Duration.DurationInput | undefined): RequestPlanTransform =>
  (plan) =>
    plan.setTimeout(timeout);
