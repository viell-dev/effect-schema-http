/** Server-backed coverage of repeated request and response header field lines. */
import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { createServer, request as sendNodeRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachHeaderEntries, createApi, getHeaderEntries, response } from "../src/main.js";

const entriesFromRawHeaders = (rawHeaders: ReadonlyArray<string>) => {
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    entries.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return entries;
};

const makeNodeClient = (): HttpClient.HttpClient =>
  HttpClient.makeWith<never, never, HttpClientError.HttpClientError, never>(
    (requestEffect) =>
      Effect.flatMap(requestEffect, (request) =>
        Effect.tryPromise({
          try: () =>
            new Promise<HttpClientResponse.HttpClientResponse>((resolve, reject) => {
              const url = new URL(request.url);
              const headerEntries = getHeaderEntries(request);
              const headers = headerEntries.flatMap(([name, value]) => [name, value]);
              if (!headerEntries.some(([name]) => name === "host")) headers.push("host", url.host);
              const outgoing = sendNodeRequest(
                url,
                {
                  headers,
                  method: request.method,
                },
                (incoming) => {
                  const chunks: Array<Buffer> = [];
                  incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                  incoming.once("error", reject);
                  incoming.once("end", () => {
                    const responseHeaderEntries = entriesFromRawHeaders(incoming.rawHeaders);
                    const source = new Response(Buffer.concat(chunks), {
                      headers: responseHeaderEntries.map(([name, value]) => [name, value]),
                      status: incoming.statusCode ?? 500,
                      statusText: incoming.statusMessage,
                    });
                    const clientResponse = HttpClientResponse.fromWeb(request, source);
                    resolve(attachHeaderEntries(clientResponse, responseHeaderEntries));
                  });
                },
              );
              outgoing.once("error", reject);
              outgoing.end();
            }),
          catch: (cause) =>
            new HttpClientError.RequestError({
              request,
              reason: "Transport",
              cause,
            }),
        }),
      ),
    Effect.succeed,
  );

describe("repeated headers", () => {
  let server: Server;
  let baseUrl: string;
  let receivedHeaders: ReadonlyArray<readonly [string, string]> = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, outgoing) => {
      receivedHeaders = entriesFromRawHeaders(request.rawHeaders);
      outgoing.setHeader("content-type", "application/json");
      outgoing.setHeader("x-result", ["first", "second"]);
      outgoing.setHeader("set-cookie", ["session=one; Path=/", "preference=compact; Path=/"]);
      outgoing.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it("preserves request and response field lines for a capable provider", async () => {
    const call = createApi(baseUrl, {
      headers: { "x-foo": ["api", "remove"] },
    }).createRequest({
      method: "GET",
      path: "/headers",
      responses: [
        response(
          {
            _tag: "ok",
            status: 200,
            headers: {
              "x-result": (_combined, values) => values.join(",") === "first,second",
            },
          },
          Schema.Struct({ ok: Schema.Literal(true) }),
        ),
      ],
    });

    const result = await call()
      .appendHeader("x-foo", "call")
      .removeHeader("x-foo", "remove")
      .effect.pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, makeNodeClient())), Effect.runPromise);

    expect(receivedHeaders.filter(([name]) => name.toLowerCase() === "x-foo")).toEqual([
      ["x-foo", "api"],
      ["x-foo", "call"],
    ]);
    expect(result.headerEntries.filter(([name]) => name === "x-result")).toEqual([
      ["x-result", "first"],
      ["x-result", "second"],
    ]);
    expect(result.cookies.cookies.session?.value).toBe("one");
    expect(result.cookies.cookies.preference?.value).toBe("compact");
  });
});
