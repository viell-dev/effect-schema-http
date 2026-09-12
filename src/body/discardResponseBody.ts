import { HttpClientResponse } from "@effect/platform";
import { Effect, Stream } from "effect";

/** Drains a response without accumulating its payload, treating an absent body as already consumed. */
export const discardResponseBody = (raw: HttpClientResponse.HttpClientResponse) =>
  Stream.runDrain(raw.stream).pipe(
    Effect.catchAll((error) => (error.reason === "EmptyBody" ? Effect.void : Effect.fail(error))),
  );
