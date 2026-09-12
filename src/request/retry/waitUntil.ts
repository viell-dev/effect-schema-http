import { Clock, Duration, Effect } from "effect";

export const waitUntil = (timestamp: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sleep(Duration.millis(Math.max(0, timestamp - now))));
