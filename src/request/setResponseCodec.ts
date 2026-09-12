import { type DefaultResponseBodyCodec, type RequestPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.setResponseCodec}. */
export const setResponseCodec =
  (codec: DefaultResponseBodyCodec): RequestPlanTransform =>
  (plan) =>
    plan.setResponseCodec(codec);
