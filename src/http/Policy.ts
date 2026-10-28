import { Cause, Duration, Result, Schedule } from "effect";
import { Headers, HttpClientError } from "effect/http";
import type * as Response from "./Response.js";

/** What a completed attempt produced. Reasons hold no live body or transport resource. */
export type Reason =
  | { readonly _tag: "Response"; readonly metadata: Response.Metadata }
  | {
      readonly _tag: "Failure";
      readonly cause: Cause.Cause<unknown>;
      /** Present when a response arrived before the failure: a decoding failure, or middleware rejecting it. */
      readonly metadata?: Response.Metadata | undefined;
    };

/** Attempt retries for one operation evaluation. One schedule owns the budget across every retry reason. */
export interface Policy<out E = never, out R = never> {
  readonly schedule: Schedule.Schedule<unknown, Reason, E, R>;
  readonly while: (reason: Reason) => boolean;
  readonly attemptTimeout: Duration.Input | undefined;
  readonly retryAfter: boolean;
}

const isTransientStatus = (status: number): boolean =>
  status === 408 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

const isTransientError = (error: unknown): boolean =>
  Cause.isTimeoutError(error) ||
  (HttpClientError.isHttpClientError(error) &&
    (error.reason._tag === "TransportError" ||
      (error.reason._tag === "StatusCodeError" &&
        isTransientStatus(error.reason.response.status))));

/** The classification of `HttpClient.retryTransient`: timeouts, transport failures and transient statuses. */
export const transient = (reason: Reason): boolean => {
  if (
    reason.metadata !== undefined &&
    isTransientStatus(reason.metadata.status)
  )
    return true;
  if (reason._tag === "Response") return false;
  return reason.cause.reasons.some(
    (failure) => Cause.isFailReason(failure) && isTransientError(failure.error),
  );
};

/** Opt into retries. `while` replaces the {@link transient} classifier; `Retry-After` is honoured by default. */
export const make = <Out, E = never, R = never>(
  schedule: Schedule.Schedule<Out, Reason, E, R>,
  options?: {
    readonly while?: ((reason: Reason) => boolean) | undefined;
    readonly attemptTimeout?: Duration.Input | undefined;
    readonly retryAfter?: boolean | undefined;
  },
): Policy<E, R> => ({
  schedule,
  while: options?.while ?? transient,
  attemptTimeout: options?.attemptTimeout,
  retryAfter: options?.retryAfter ?? true,
});

/** A single attempt. */
export const none: Policy = make(Schedule.recurs(0));

/**
 * The minimum delay a response requests through `Retry-After` (delay seconds or an HTTP date). Absent,
 * malformed, or unrepresentable values request no delay.
 */
export const retryAfterDelay = (
  metadata: Response.Metadata,
  now: number,
): Duration.Duration => {
  const value = metadata.headers["retry-after"];
  if (value === undefined) return Duration.zero;
  const parsed = Headers.parseRetryAfter(value);
  if (Result.isFailure(parsed)) return Duration.zero;
  const delay = Headers.retryAfterDelay(parsed.success, now);
  return Number.isFinite(Duration.toMillis(delay)) ? delay : Duration.zero;
};
