import { type RetryInput, type RetryPolicy } from "../types.js";
import { isTransientRetryInput } from "./isTransientRetryInput.js";

export const isRetryable = (input: RetryInput, additional: RetryPolicy["while"]): boolean =>
  isTransientRetryInput(input) || additional?.(input) === true;
