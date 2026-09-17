import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Effect, Layer } from "effect";
import { request as sendNodeRequest } from "node:http";
import { Transport } from "viell-effect-schema-http";

/**
 * Node-only provider for the Rust service's repeated X-Scope request lines.
 * Operation supplies Transport.HeaderLines; Transport.headerLines reconciles those
 * declarations with the final native request. Fetch combines them and Rust rejects it.
 * Responses use Platform's normalized headers and cookie representation.
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

/** The client itself, suitable for Operation.make options.transformClient or a layer. */
export const repeatedHeaderClient: HttpClient.HttpClient = HttpClient.makeWith<
  never,
  never,
  HttpClientError.HttpClientError,
  never
>(
  (requestEffect) =>
    Effect.flatMap(requestEffect, (request) =>
      Effect.flatMap(Transport.headerLines(request), (headerEntries) =>
        Effect.tryPromise({
          try: () =>
            new Promise<HttpClientResponse.HttpClientResponse>((resolve, reject) => {
              const url = new URL(request.url);
              // The plan's own ordered entries, not the normalized record: this is the
              // only representation in which `x-scope: a` and `x-scope: b` are still two
              // separate lines.
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
                  resolve(HttpClientResponse.fromWeb(request, source));
                });
              });

              outgoing.once("error", reject);
              if (payload !== undefined) outgoing.write(payload);
              outgoing.end();
            }),
          catch: (cause) => new HttpClientError.RequestError({ request, reason: "Transport", cause }),
        }),
      ),
    ),
  Effect.succeed,
);

/** Layer form, for running a whole program against this provider. */
export const RepeatedHeaderClientLayer = Layer.succeed(HttpClient.HttpClient, repeatedHeaderClient);
