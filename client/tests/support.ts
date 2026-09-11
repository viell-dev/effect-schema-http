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
    const body = (envelope as { readonly body?: unknown }).body;
    throw new Error(`expected response ${JSON.stringify(tag)} but received ${JSON.stringify(envelope._tag)}: ${JSON.stringify(body)}`);
  }
  return envelope as Extract<Envelope, { readonly _tag: Tag }>;
};

type AnyPlan<Envelope> = {
  readonly effect: Effect.Effect<Envelope, unknown, HttpClient.HttpClient>;
};

/** Executes a plan and narrows the result to one expected tag. */
export const call = async <Envelope extends { readonly _tag: string }, const Tag extends Envelope["_tag"]>(
  plan: AnyPlan<Envelope>,
  tag: Tag,
): Promise<Extract<Envelope, { readonly _tag: Tag }>> => expectTag(await run(plan.effect as Effect.Effect<Envelope, never, HttpClient.HttpClient>), tag);

/** Executes a plan and returns the whole envelope, whichever tag it carries. */
export const callAny = async <Envelope>(plan: AnyPlan<Envelope>): Promise<Envelope> =>
  run(plan.effect as Effect.Effect<Envelope, never, HttpClient.HttpClient>);

/**
 * Executes a plan expecting it to *fail*, and returns the typed failure.
 *
 * Library failures — `RequestBodyNotAllowed`, `ResponseDecodeError`, `UnhandledResponse`
 * — live in the Effect error channel, unlike mapped non-2xx responses, which do not.
 * Reading them through `Effect.either` keeps the tag rather than flattening everything
 * into a `FiberFailure` whose message is "An error has occurred".
 */
export const callFailure = async <Envelope, Error>(plan: {
  readonly effect: Effect.Effect<Envelope, Error, HttpClient.HttpClient>;
}): Promise<Error> => {
  const result = await run(Effect.either(plan.effect));
  if (result._tag === "Right") {
    throw new Error(`expected a failure but the request succeeded: ${JSON.stringify(result.right)}`);
  }
  return result.left;
};

/** Executes a plan against the repeated-header `node:http` provider instead of Fetch. */
export const callWithRepeatedHeaders = <Envelope>(plan: AnyPlan<Envelope>): Promise<Envelope> =>
  Effect.runPromise(
    Effect.provide(plan.effect, RepeatedHeaderClientLayer) as Effect.Effect<Envelope, never, never>,
  );

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
  return checks.every(Boolean);
};
