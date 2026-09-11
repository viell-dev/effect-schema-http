import { FetchHttpClient, type HttpClient } from "@effect/platform";
import { Effect } from "effect";

/**
 * Runs an Effect requiring HttpClient using FetchHttpClient.layer.
 */
export const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer));
