import { createServer, type RequestListener } from "node:http";
import { FetchHttpClient } from "@effect/platform";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const withServer = async (handler: RequestListener, use: (url: string) => Promise<void>) => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    await use(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

describe("Fetch transport integration", () => {
  it("round-trips encoded bodies and repeated queries, and preserves response cookies", async () => {
    await withServer(
      (request, response) => {
        const parts: Array<Buffer> = [];
        request.on("data", (part: Buffer) => parts.push(part));
        request.on("end", () => {
          expect(request.url).toBe("/items?q=a%20b&q=c");
          expect(request.headers["content-type"]).toBe("application/json");
          response.writeHead(201, {
            "content-type": "application/json",
            "set-cookie": ["first=1; Path=/", "second=2; Path=/"],
          });
          response.end(Buffer.concat(parts));
        });
      },
      async (url) => {
        const codec = Body.jsonSchema(Schema.Struct({ value: Schema.NumberFromString }));
        const create = Operation.make(
          Request.post("/items").pipe(
            Request.baseUrl(url),
            Request.setQuery("q", "a b"),
            Request.appendQuery("q", "c"),
            Request.body(codec),
          ),
          Response.status(201, Response.tag("Created", codec)),
        );
        const result = await Effect.runPromise(
          create.execute({ body: { value: 42 } }).pipe(Effect.provide(FetchHttpClient.layer)),
        );
        expect(result.value).toEqual({ value: 42 });
        expect(Object.keys(result.metadata.cookies.cookies)).toEqual(["first", "second"]);
      },
    );
  });

  it("aborts an in-progress body read when the executing fiber is interrupted", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("partial");
        response.on("close", closed);
        Effect.runSync(Deferred.succeed(started, undefined));
      },
      async (url) => {
        const operation = Operation.make(Request.get(url), Response.status(200, Body.text));
        await Effect.runPromise(
          Effect.gen(function* () {
            const running = yield* Effect.fork(operation.execute(undefined));
            yield* Deferred.await(started);
            yield* Fiber.interrupt(running);
            yield* Effect.promise(() => socketClosed);
          }).pipe(Effect.timeout("2 seconds"), Effect.provide(FetchHttpClient.layer)),
        );
      },
    );
  });

  it("sends binary and multipart bodies without imposing a JSON contract", async () => {
    await withServer(
      (request, response) => {
        const parts: Array<Buffer> = [];
        request.on("data", (part: Buffer) => parts.push(part));
        request.on("end", () => {
          if (request.url === "/binary") response.end(Buffer.concat(parts));
          else {
            expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
            expect(Buffer.concat(parts).toString()).toContain('name="message"');
            response.end("uploaded");
          }
        });
      },
      async (url) => {
        const binary = Operation.make(
          Request.post(`${url}/binary`).pipe(Request.body(Body.bytes)),
          Response.status(200, Body.bytes),
        );
        const output = await Effect.runPromise(
          binary.execute({ body: new Uint8Array([0, 255, 42]) }).pipe(Effect.provide(FetchHttpClient.layer)),
        );
        expect([...output]).toEqual([0, 255, 42]);
        const form = new FormData();
        form.set("message", "hello");
        const upload = Operation.make(
          Request.post(`${url}/form`).pipe(Request.body(Body.formData)),
          Response.status(200, Body.text),
        );
        expect(
          await Effect.runPromise(upload.execute({ body: form }).pipe(Effect.provide(FetchHttpClient.layer))),
        ).toBe("uploaded");
      },
    );
  });
});
