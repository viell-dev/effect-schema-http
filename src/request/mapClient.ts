import { HttpClient } from "@effect/platform";
import { type RequestPlanTransform } from "./types.js";

/** Pipeable form of {@link RequestPlan.mapClient}. */
export const mapClient =
  (transform: (client: HttpClient.HttpClient) => HttpClient.HttpClient): RequestPlanTransform =>
  (plan) =>
    plan.mapClient(transform);
