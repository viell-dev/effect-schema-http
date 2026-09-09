import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, response } from "../src/main.js";

const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
const ThinUser = Schema.Struct({ id: Schema.Number });

describe("request integration", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, outgoing) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const thin = url.searchParams.get("fields") === "id";

      outgoing.writeHead(200, {
        "content-type": "application/json",
        "x-request-auth": request.headers.authorization ?? "",
        ...(thin ? { "x-response-shape": "thin" } : {}),
      });
      outgoing.end(JSON.stringify(thin ? [{ id: 1 }] : [{ id: 1, name: "Ada" }]));
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

  it("serializes a real request and selects a response schema from real response metadata", async () => {
    const getUsers = createApi(baseUrl, { headers: { authorization: "Bearer integration" } }).createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ status: 200 }, Schema.Array(User))] as const,
    });

    const result = await getUsers()
      .setUrlParam("fields", "id")
      .setResponseSchema({ status: 200 }, Schema.Array(ThinUser))
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(result).toMatchObject({ status: 200, body: [{ id: 1 }] });
  });
});
