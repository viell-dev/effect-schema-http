import { FetchHttpClient, type HttpClient } from "@effect/platform";
import { Effect, type Fiber } from "effect";

/**
 * The one place this application chooses a transport.
 *
 * The library never picks one: a request Effect requires `HttpClient.HttpClient` and
 * says so in its type, which is why `repeatedHeaderClient.ts` can be swapped in for the
 * one endpoint that needs a provider preserving repeated header field lines.
 */
export const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer));

/**
 * Starts an Effect and hands back its fiber, so a caller can interrupt it.
 *
 * Interruption is the library's cancellation mechanism, and `FetchHttpClient` turns it
 * into a real `AbortController.abort()` — which is what makes a superseded keystroke
 * stop on the wire rather than merely being ignored when it lands.
 */
export const runFork = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Fiber.RuntimeFiber<A, E> =>
  Effect.runFork(Effect.provide(effect, FetchHttpClient.layer));
