import { Cause, Duration, Effect } from "effect";

export const withAttemptTimeout = <Success, Error, Requirements>(
  effect: Effect.Effect<Success, Error, Requirements>,
  timeout: Duration.DurationInput | undefined,
): Effect.Effect<Success, Error | Cause.TimeoutException, Requirements> =>
  timeout === undefined ? effect : Effect.timeout(effect, timeout);
