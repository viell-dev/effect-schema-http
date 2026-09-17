import { createServer, request as sendRequest, type RequestListener } from "node:http";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import * as Transport from "./Transport.js";

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
  it("sends bare query flags and preserves repeated physical headers with a supporting provider", async () => {
    await withServer(
      (request, response) => {
        expect(request.url).toBe("/contract?wsdl&empty=");
        const scopes: Array<string> = [];
        request.rawHeaders.forEach((value, index) => {
          if (index % 2 === 0 && value.toLowerCase() === "x-scope") scopes.push(request.rawHeaders[index + 1]);
        });
        response.end(JSON.stringify(scopes));
      },
      async (url) => {
        const client = HttpClient.make((request, _url, signal) =>
          Effect.flatMap(Transport.headerLines(request), (lines) =>
            Effect.tryPromise({
              try: () =>
                new Promise<HttpClientResponse.HttpClientResponse>((resolve, reject) => {
                  const outgoing = sendRequest(
                    request.url,
                    {
                      method: request.method,
                      headers: ["host", new URL(request.url).host, ...lines.flatMap(([key, value]) => [key, value])],
                      signal,
                    },
                    (incoming) => {
                      const chunks: Array<Buffer> = [];
                      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                      incoming.on("error", reject);
                      incoming.on("end", () =>
                        resolve(
                          HttpClientResponse.fromWeb(
                            request,
                            new globalThis.Response(new Uint8Array(Buffer.concat(chunks)), {
                              status: incoming.statusCode,
                            }),
                          ),
                        ),
                      );
                    },
                  );
                  outgoing.on("error", reject);
                  outgoing.end();
                }),
              catch: (cause) => new HttpClientError.RequestError({ request, reason: "Transport", cause }),
            }),
          ),
        );
        const operation = Operation.make(
          Request.get(`${url}/contract?wsdl&empty=`).pipe(
            Request.appendHeader("X-Scope", "openid"),
            Request.appendHeader("X-Scope", "projects:read"),
          ),
          Response.status(200, Body.jsonSchema(Schema.Array(Schema.String))),
        );
        expect(
          await Effect.runPromise(
            operation.execute(undefined).pipe(Effect.provideService(HttpClient.HttpClient, client)),
          ),
        ).toEqual(["openid", "projects:read"]);
        expect(
          await Effect.runPromise(operation.execute(undefined).pipe(Effect.provide(FetchHttpClient.layer))),
        ).toEqual(["openid, projects:read"]);
      },
    );
  });

  it("leaves redirects and other request-init options under provider control", async () => {
    await withServer(
      (request, response) => {
        if (request.url === "/old") {
          response.writeHead(301, { location: "/new" });
          response.end("moved");
        } else response.end("arrived");
      },
      async (url) => {
        const operation = Operation.make(
          Request.get(`${url}/old`),
          Response.status(301, Response.tag("Moved", Body.text)).pipe(
            Response.orElse(Response.status(200, Response.tag("Arrived", Body.text))),
          ),
        );
        expect(
          (await Effect.runPromise(operation.execute(undefined).pipe(Effect.provide(FetchHttpClient.layer))))._tag,
        ).toBe("Arrived");
        const manual = await Effect.runPromise(
          operation
            .execute(undefined)
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
              Effect.provide(FetchHttpClient.layer),
            ),
        );
        expect(manual).toMatchObject({ _tag: "Moved", metadata: { headers: { location: "/new" } } });
      },
    );
  });
});
