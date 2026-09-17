import type { HttpClient } from "@effect/platform";
import { Effect, Layer } from "effect";
import { run } from "../src/runtime.js";
import { RepeatedHeaderClientLayer } from "../src/services/repeatedHeaderClient.js";

/**
 * Test helpers for working with mapped response unions.
 *
 * Every endpoint in this client can answer with more than one tag, because that is the
 * library's model: a mapped `401`, `409` or `503` is an ordinary success value carrying
 * a decoded body, not a thrown error. That means a test must *narrow* before it reads a
 * body, exactly as application code does. `expectTag` is the narrowing step, and it
 * fails with the tag and body it actually received, which turns "property does not exist
 * on type" into a readable assertion failure.
 */

/** Narrows a response envelope to one tag, or fails the test with what actually arrived. */
export const expectTag = <Envelope extends { readonly _tag: string }, const Tag extends Envelope["_tag"]>(
  envelope: Envelope,
  tag: Tag,
): Extract<Envelope, { readonly _tag: Tag }> => {
  if (envelope._tag !== tag) {
    const body = (envelope as { readonly value?: unknown }).value;
    throw new Error(
      `expected response ${JSON.stringify(tag)} but received ${JSON.stringify(envelope._tag)}: ${JSON.stringify(body)}`,
    );
  }
  return envelope as Extract<Envelope, { readonly _tag: Tag }>;
};

/** Execute ordinary Effects while retaining each operation's precise error and value types. */
export const call = async <Envelope extends { readonly _tag: string }, E, const Tag extends Envelope["_tag"]>(
  effect: Effect.Effect<Envelope, E, HttpClient.HttpClient>,
  tag: Tag,
): Promise<Extract<Envelope, { readonly _tag: Tag }>> => expectTag(await run(effect), tag);

export const callAny = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> => run(effect);
export const callFailure = async <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<E> => {
  const result = await run(Effect.either(effect));
  if (result._tag === "Right") throw new Error(`expected failure, received ${JSON.stringify(result.right)}`);
  return result.left;
};
export const callWithRepeatedHeaders = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, RepeatedHeaderClientLayer));

/** A layer bundle for programs that need to name their own provider. */
export const providers = {
  repeatedHeaders: RepeatedHeaderClientLayer,
  none: Layer.empty,
};

/**
 * Reports whether the backend services this suite needs are listening.
 *
 * Two attempts with a generous timeout, because these checks run while other test files
 * are hammering the same five processes — one of which deliberately holds a connection
 * open for five seconds — and a suite that silently skips itself under load is worse
 * than one that waits.
 */
export const servicesUp = async (ports: ReadonlyArray<number>): Promise<boolean> => {
  const reachable = async (port: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(5000) });
        if (response.ok) return true;
      } catch {
        // Fall through to the retry.
      }
    }
    return false;
  };

  const checks = await Promise.all(ports.map(reachable));
  const available = checks.every(Boolean);
  if (!available && process.env.REQUIRE_SERVICES === "1") {
    throw new Error(`Required services are unavailable: ${ports.filter((_, index) => !checks[index]).join(", ")}`);
  }
  return available;
};
