import { FetchHttpClient, type HttpClient } from "@effect/platform";
import { Effect } from "effect";

/** Provides `FetchHttpClient.layer`, the same provider the library's own README quick-start
 * uses: an explicit choice, never an implicit default the library makes for us. */
export const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer));
