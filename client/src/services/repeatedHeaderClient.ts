import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Effect, Layer } from "effect";
import { request as sendNodeRequest } from "node:http";
import { attachHeaderEntries, getHeaderEntries } from "viell-effect-schema-http";

/**
 * A `node:http` provider that preserves repeated header field lines in both directions.
 *
 * The library retains repeated header entries on a plan, but says plainly that whether
 * they reach the wire is a property of the transport: "Effect Platform normalizes
 * headers. Plans retain repeated header entries separately, but the default Fetch
 * provider may combine them on the wire. APIs that require repeated physical header
 * field lines need a provider that reads `getHeaderEntries(request)` and preserves that
 * representation."
 *
 * The ID server's `/token/scoped` endpoint is such an API: it reads `get_all("x-scope")`
 * and rejects a comma-joined value, because a comma is a legal character in a scope name
 * and its 2019 parser never split on one. So this file is the documented escape hatch,
 * written out: about forty lines, no library support needed beyond the two exported
 * functions that exist for exactly this.
 *
 * It is Node-only. In a browser there is no equivalent — `Headers` combines repeated
 * entries before `fetch` ever sees them — which is a genuine, unavoidable limitation of
 * the platform rather than of this library, and worth knowing before designing a header
 * that way.
 */

const entriesFromRawHeaders = (rawHeaders: ReadonlyArray<string>): Array<readonly [string, string]> => {
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    entries.push([rawHeaders[index] ?? "", rawHeaders[index + 1] ?? ""]);
  }
  return entries;
};

const bodyBytes = (body: { readonly _tag: string }): Uint8Array | undefined => {
  switch (body._tag) {
    case "Empty":
      return undefined;
    case "Uint8Array":
      return (body as unknown as { readonly body: Uint8Array }).body;
    case "Raw": {
      const raw = (body as unknown as { readonly body: unknown }).body;
      if (typeof raw === "string") return new TextEncoder().encode(raw);
      if (raw instanceof Uint8Array) return raw;
      return new TextEncoder().encode(JSON.stringify(raw));
    }
    default:
      return undefined;
  }
};

/** The client itself, suitable for `.mapClient(() => repeatedHeaderClient)` or a layer. */
export const repeatedHeaderClient: HttpClient.HttpClient = HttpClient.makeWith<
  never,
  never,
  HttpClientError.HttpClientError,
  never
>(
  (requestEffect) =>
    Effect.flatMap(requestEffect, (request) =>
      Effect.tryPromise({
        try: () =>
          new Promise<HttpClientResponse.HttpClientResponse>((resolve, reject) => {
            const url = new URL(request.url);
            // The plan's own ordered entries, not the normalized record: this is the
            // only representation in which `x-scope: a` and `x-scope: b` are still two
            // separate lines.
            const headerEntries = getHeaderEntries(request);
            const headers = headerEntries.flatMap(([name, value]) => [name, value]);
            if (!headerEntries.some(([name]) => name.toLowerCase() === "host")) {
              headers.push("host", url.host);
            }

            const payload = bodyBytes(request.body);
            if (payload !== undefined) headers.push("content-length", String(payload.byteLength));

            const outgoing = sendNodeRequest(url, { headers, method: request.method }, (incoming) => {
              const chunks: Array<Buffer> = [];
              incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
              incoming.once("error", reject);
              incoming.once("end", () => {
                const responseEntries = entriesFromRawHeaders(incoming.rawHeaders);
                const source = new Response(
                  // A 204/304 response must not carry a body, even an empty one.
                  incoming.statusCode === 204 || incoming.statusCode === 304
                    ? null
                    : new Uint8Array(Buffer.concat(chunks)),
                  {
                    headers: responseEntries.map(([name, value]) => [name, value] as [string, string]),
                    status: incoming.statusCode ?? 500,
                    ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
                  },
                );
                resolve(attachHeaderEntries(HttpClientResponse.fromWeb(request, source), responseEntries));
              });
            });

            outgoing.once("error", reject);
            if (payload !== undefined) outgoing.write(payload);
            outgoing.end();
          }),
        catch: (cause) => new HttpClientError.RequestError({ request, reason: "Transport", cause }),
      }),
    ),
  Effect.succeed,
);

/** Layer form, for running a whole program against this provider. */
export const RepeatedHeaderClientLayer = Layer.succeed(HttpClient.HttpClient, repeatedHeaderClient);
