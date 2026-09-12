import { HttpClientRequest } from "@effect/platform";
import { type RequestPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.mapRequest}. */
export const mapRequest =
  (
    transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ): RequestPlanTransform =>
  (plan) =>
    plan.mapRequest(transform);
