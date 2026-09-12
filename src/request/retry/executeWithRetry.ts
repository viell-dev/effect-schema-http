import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Cause, Clock, Duration, Effect, ScheduleDecision, ScheduleIntervals } from "effect";
import { discardResponseBody } from "../../body/discardResponseBody.js";
import { type RetryInput, type RetryPolicy } from "../types.js";
import { defaultRetrySchedule } from "./defaultRetrySchedule.js";
import { isRetryable } from "./isRetryable.js";
import { isRetryInput } from "./isRetryInput.js";
import { retryAfterTimestamp } from "./retryAfterTimestamp.js";
import { waitUntil } from "./waitUntil.js";
import { withAttemptTimeout } from "./withAttemptTimeout.js";

export const executeWithRetry = <Success, HandlingError, Requirements, Error extends HttpClientError.HttpClientError>(
  client: HttpClient.HttpClient.With<Error>,
  request: HttpClientRequest.HttpClientRequest,
  retry: RetryPolicy | undefined,
  timeout: Duration.DurationInput | undefined,
  handleResponse: (raw: HttpClientResponse.HttpClientResponse) => Effect.Effect<Success, HandlingError, Requirements>,
): Effect.Effect<
  Success,
  Error | HandlingError | HttpClientError.ResponseError | Cause.TimeoutException,
  Requirements
> => {
  const mode = retry?.mode ?? "both";
  const times = retry?.times ?? 0;
  const schedule = retry?.schedule ?? defaultRetrySchedule;
  const respectRetryAfter = retry?.respectRetryAfter ?? true;

  return Effect.gen(function* () {
    let scheduleState = schedule.initial;
    let retries = 0;

    const nextRetryAt = (input: RetryInput) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [nextState, , decision] = yield* schedule.step(now, input, scheduleState);
        scheduleState = nextState;
        if (ScheduleDecision.isDone(decision)) return undefined;

        const scheduled = ScheduleIntervals.start(decision.intervals);
        const retryAfter = respectRetryAfter ? retryAfterTimestamp(input, now) : undefined;
        return retryAfter === undefined ? scheduled : Math.max(scheduled, retryAfter);
      });

    while (true) {
      const attempt = withAttemptTimeout(
        Effect.gen(function* () {
          const raw = yield* client.execute(request);
          if (mode !== "errors-only" && retries < times && isRetryable(raw, retry?.while)) {
            return { _tag: "RetryResponse" as const, response: raw };
          }
          return { _tag: "Done" as const, value: yield* handleResponse(raw) };
        }),
        timeout,
      );
      const outcome = yield* Effect.either(attempt);

      if (outcome._tag === "Left") {
        if (
          mode === "response-only" ||
          retries >= times ||
          !isRetryInput(outcome.left) ||
          !isRetryable(outcome.left, retry?.while)
        ) {
          return yield* Effect.fail(outcome.left);
        }

        const retryAt = yield* nextRetryAt(outcome.left);
        if (retryAt === undefined) return yield* Effect.fail(outcome.left);

        yield* waitUntil(retryAt);
        retries += 1;
        continue;
      }

      if (outcome.right._tag === "Done") return outcome.right.value;

      const retryAt = yield* nextRetryAt(outcome.right.response);
      if (retryAt === undefined) return yield* withAttemptTimeout(handleResponse(outcome.right.response), timeout);

      yield* withAttemptTimeout(discardResponseBody(outcome.right.response), timeout);
      yield* waitUntil(retryAt);
      retries += 1;
    }
  });
};
