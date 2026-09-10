/** Server-backed coverage of interrupting an ordinary request while its response body is streaming. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Cause, Effect, Exit, Fiber, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequest, response } from "../src/main.js";

describe("request interruption", () => {
  let server: Server;
  let baseUrl: string;
  let bodyStarted: Promise<void>;
  let connectionClosed: Promise<void>;
  let markBodyStarted: (() => void) | undefined;
  let markConnectionClosed: (() => void) | undefined;

  beforeAll(async () => {
    server = createServer((_request, outgoing) => {
      outgoing.once("close", () => markConnectionClosed?.());
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.write('{"value":"unfinished');
      markBodyStarted?.();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    bodyStarted = new Promise((resolve) => {
      markBodyStarted = resolve;
    });
    connectionClosed = new Promise((resolve) => {
      markConnectionClosed = resolve;
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it("closes the Fetch exchange when body decoding is interrupted", async () => {
    const getValue = createRequest({
      method: "GET",
      path: `${baseUrl}/value`,
      responses: [response({ _tag: "ok", status: 200 }, Schema.Struct({ value: Schema.String }))],
    });
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(getValue().effect);
      yield* Effect.promise(() => bodyStarted);
      return yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const exit = await Effect.runPromise(program);
    await connectionClosed;

    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
  });
});
