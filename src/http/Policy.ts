import { HttpClientError } from "@effect/platform";
import { Cause, Duration, Schedule } from "effect";
import type * as Response from "./Response.js";

/** Retry observations contain no live body or transport resource. */
export type Reason =
  | { readonly _tag: "Response"; readonly metadata: Response.Metadata }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown>; readonly metadata?: Response.Metadata };

export interface Policy<out R = never> {
  readonly schedule: Schedule.Schedule<unknown, Reason, R>;
  readonly while: (reason: Reason) => boolean;
  readonly attemptTimeout?: Duration.DurationInput;
  readonly retryAfter: boolean;
}

const transientStatus = (status: number): boolean => [408, 429, 500, 502, 503, 504].includes(status);

/** Matches the installed Platform retryTransient classification. */
export const transient = (reason: Reason): boolean => {
  const status = reason.metadata?.status;
  if (status !== undefined && transientStatus(status)) return true;
  if (reason._tag === "Response") return false;
  return Array.from(Cause.failures(reason.cause)).some(
    (error) =>
      Cause.isTimeoutException(error) ||
      (HttpClientError.isHttpClientError(error) &&
        ((error._tag === "RequestError" && error.reason === "Transport") ||
          (error._tag === "ResponseError" && transientStatus(error.response.status)))),
  );
};

/** Retries are opt-in. One schedule owns the budget across every retry reason. */
export const make = <Out, R>(
  schedule: Schedule.Schedule<Out, Reason, R>,
  options?: {
    readonly while?: (reason: Reason) => boolean;
    readonly attemptTimeout?: Duration.DurationInput;
    readonly retryAfter?: boolean;
  },
): Policy<R> => ({
  schedule,
  while: options?.while ?? transient,
  attemptTimeout: options?.attemptTimeout,
  retryAfter: options?.retryAfter ?? true,
});

export const none: Policy = make(Schedule.recurs(0));

/** Absolute lower bound; delay is combined with schedule time rather than added to it. */
export const retryAfterTime = (metadata: Response.Metadata, now: number): number => {
  const value = metadata.headers["retry-after"];
  if (value === undefined) return now;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const deadline = now + Number(value) * 1_000;
    return Number.isFinite(deadline) ? deadline : now;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : now;
};
