import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, response } from "../src/main.js";

const ReflectedQuery = Schema.Struct({ query: Schema.String });

describe("query parameter wire syntax", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, outgoing) => {
      const queryIndex = (request.url ?? "").indexOf("?");
      const query = queryIndex === -1 ? "" : (request.url ?? "").slice(queryIndex + 1);
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ query }));
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

  it("distinguishes bare, empty, and explicit boolean strings", async () => {
    const inspectQuery = createApi(baseUrl, { urlParams: { apiFlag: true } }).createRequest({
      method: "GET",
      path: "/inspect?pathFlag&pathEmpty=&pathFalse=false",
      urlParams: { endpointFlag: true },
      responses: [response({ key: "ok", status: 200 }, ReflectedQuery)],
    });

    const result = await inspectQuery()
      .setUrlParams({ planFlag: true, planEmpty: "", planTrue: "true", planFalse: "false" })
      .appendUrlParam("repeated", true)
      .appendUrlParam("repeated", "")
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    const parts = result.body.query.split("&");

    expect(parts).toContain("apiFlag");
    expect(parts).toContain("pathFlag");
    expect(parts).toContain("pathEmpty=");
    expect(parts).toContain("pathFalse=false");
    expect(parts).toContain("endpointFlag");
    expect(parts).toContain("planFlag");
    expect(parts).toContain("planEmpty=");
    expect(parts).toContain("planTrue=true");
    expect(parts).toContain("planFalse=false");
    expect(parts.filter((part) => part.startsWith("repeated"))).toEqual(["repeated", "repeated="]);
  });
});
