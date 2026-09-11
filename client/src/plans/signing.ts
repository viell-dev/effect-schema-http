import { HttpClient, type HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import type { RequestPlanTransform } from "viell-effect-schema-http";

/**
 * HMAC request signing for the 2011 notification service.
 *
 * This is the one requirement in the whole repository that a **computed header cannot
 * satisfy**, and the reason is worth stating exactly, because it is a property of the
 * design rather than an oversight:
 *
 * - A computed header value is `() => string | undefined`. It takes no arguments, so it
 *   cannot see the request, and it runs *while the request is being materialized* —
 *   before the body schema has encoded anything. A signature over the body is therefore
 *   not expressible as a declared header, and no amount of configuration changes that.
 * - `mapRequest` runs after encoding and does see the built request, so it has the body.
 *   But it is synchronous, and `crypto.subtle.sign` is not. There is no synchronous HMAC
 *   in either a browser or modern Node without pulling in an implementation.
 * - `mapClient` takes the request Effect, so it can be effectful and it runs after
 *   encoding. That is the seam, and the library documents it as such: "They run outside
 *   the Effect runtime, so they cannot fail, retry, or be interrupted; use a request
 *   transform, `mapClient`, or a gate for anything effectful."
 *
 * So the escape hatch exists, it is documented, and it is the right one — but the
 * library's own examples only ever use `mapClient` to change transport behaviour
 * (`withTracerPropagation`), never to compute a header from the encoded body, which is
 * the most common reason a real application reaches for it.
 */

/** Committed to the repository in 2011 and never rotated. */
const SHARED_SECRET = "notify-shared-secret-2011";

const encoder = new TextEncoder();

/** Reads the encoded request body back as text, which is what the signature covers. */
const bodyText = (body: HttpClientRequest.HttpClientRequest["body"]): string => {
  switch (body._tag) {
    case "Empty":
      return "";
    case "Uint8Array":
      return new TextDecoder().decode((body as unknown as { readonly body: Uint8Array }).body);
    case "Raw": {
      const raw = (body as unknown as { readonly body: unknown }).body;
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    }
    default:
      // A stream or a multipart body cannot be signed without buffering it, which would
      // defeat the point of streaming it. The 2011 service never accepted either.
      throw new Error(`cannot sign a ${body._tag} body`);
  }
};

const hmacSha256 = (secret: string, message: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

/**
 * Signs one request.
 *
 * The message is `METHOD\nPATH\nTIMESTAMP\nBODY`, which is the 2011 house style: no
 * canonical header set and no query string, so a signed request's query parameters are
 * not actually protected. That is a real weakness of the scheme and not something the
 * client can fix from this side — it is recorded here rather than quietly worked around.
 */
export const signNotifyRequest = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
  Effect.gen(function* () {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path = new URL(request.url).pathname;
    const signature = yield* hmacSha256(
      SHARED_SECRET,
      `${request.method.toUpperCase()}\n${path}\n${timestamp}\n${bodyText(request.body)}`,
    );

    return {
      ...request,
      headers: { ...request.headers, "x-timestamp": timestamp, "x-signature": signature },
    } as HttpClientRequest.HttpClientRequest;
  });

/**
 * Sign every request this plan sends.
 *
 * Unlike a computed header, this resolves **per attempt**: `mapClient` wraps the client,
 * and the client is called again on every retry. A signature has a five-minute window,
 * so a retry that waited longer than that would fail with a header computed once — which
 * makes this the one place in the repository where per-attempt resolution is not merely
 * convenient but required.
 */
export const signed: RequestPlanTransform = (plan) =>
  plan.mapClient(HttpClient.mapRequestEffect(signNotifyRequest));
