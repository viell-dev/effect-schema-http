import { InvalidRetryCount } from "../../errors/InvalidRetryCount.js";
import { type RetryPolicy } from "../types.js";

export const normalizeRetry = (retry: RetryPolicy | number | undefined): RetryPolicy | undefined => {
  if (retry === undefined) return undefined;
  const policy = typeof retry === "number" ? { times: retry } : retry;
  if (!Number.isFinite(policy.times) || !Number.isInteger(policy.times) || policy.times < 0) {
    throw new InvalidRetryCount(policy.times);
  }
  return policy.times === 0 ? undefined : policy;
};
