/**
 * Server-backed coverage of what happens to a URL fragment.
 *
 * A fragment is a client-side concept: RFC 3986 keeps it out of the request target, and no HTTP
 * client transmits one. That makes it impossible for an API to give a fragment meaning — a
 * `/users/:id#thin` convention could never reach the server that was supposed to honour it. These
 * tests pin that end to end, because the alternative is a consumer discovering it in production.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, response, setUrlParam } from "../src/main.js";

const ReflectedTarget = Schema.Struct({ target: Schema.String });

describe("URL fragments", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      // Whatever arrives as the request target, verbatim.
      outgoing.end(JSON.stringify({ target: request.url ?? "" }));
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

  it("never sends a declared fragment to the server", async () => {
    const getThinUser = createApi(baseUrl).createRequest({
      method: "GET",
      path: "/users/:userId#thin",
      responses: [response({ _tag: "ok", status: 200 }, ReflectedTarget)],
    });

    const result = await getThinUser({ userId: "u-1" }).pipe(
      setUrlParam("expand", "profile"),
      (plan) => plan.effect,
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );

    // The query survives and is placed before the fragment, but the fragment itself is gone: an
    // API cannot use one to select a representation, because it never arrives.
    expect(result.body.target).toBe("/users/u-1?expand=profile");
    expect(result.body.target).not.toContain("#");
    expect(result.body.target).not.toContain("thin");
  });

  it("percent-encodes a # inside a path value instead of truncating the URL", async () => {
    const getDocument = createApi(baseUrl).createRequest({
      method: "GET",
      path: "/documents/:name",
      responses: [response({ _tag: "ok", status: 200 }, ReflectedTarget)],
    });

    const result = await getDocument({ name: "draft#2" }).pipe(
      (plan) => plan.effect,
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );

    // Without encoding, everything from the `#` onwards would have been dropped on the wire and
    // the server would have seen `/documents/draft`.
    expect(result.body.target).toBe("/documents/draft%232");
  });

  it("keeps a query value containing # inside the query string", async () => {
    const search = createApi(baseUrl).createRequest({
      method: "GET",
      path: "/search",
      responses: [response({ _tag: "ok", status: 200 }, ReflectedTarget)],
    });

    const result = await search().pipe(
      setUrlParam("q", "issue #42"),
      (plan) => plan.effect,
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );

    expect(result.body.target).toBe("/search?q=issue+%2342");
  });
});
