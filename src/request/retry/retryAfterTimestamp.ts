import { type RetryInput } from "../types.js";
import { responseFromRetryInput } from "./responseFromRetryInput.js";

export const retryAfterTimestamp = (input: RetryInput, now: number): number | undefined => {
  const value = responseFromRetryInput(input)?.headers["retry-after"]?.trim();
  if (value === undefined || value === "") return undefined;

  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isFinite(milliseconds) ? now + milliseconds : undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : undefined;
};
