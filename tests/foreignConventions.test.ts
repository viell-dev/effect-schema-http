/**
 * Server-backed coverage of conventions that come from services this library did not
 * design and cannot change.
 *
 * Every case here was found by a consuming project that points one client at five
 * backends written in five languages over twelve years. They are pinned because each one
 * is a decision a reader could reasonably expect to go the other way, and because a
 * consumer discovering them for the first time should be able to find them written down.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Either, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, RequestBody, response, ResponseBody } from "../src/main.js";

const readText = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (outgoing: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  outgoing.writeHead(status, { "content-type": "application/json", ...headers });
  outgoing.end(JSON.stringify(body));
};

describe("conventions from services we do not control", () => {
  let server: Server;
  let baseUrl: string;
  const observed: Array<{
    readonly method: string;
    readonly path: string;
    readonly contentType?: string | undefined;
    readonly body: string;
  }> = [];
  let throttleAttempts = 0;
  let warmUpAttempts = 0;

  beforeAll(async () => {
    server = createServer((request, outgoing) => {
      const handle = async () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const body = await readText(request);
        observed.push({
          method: request.method ?? "",
          path: url.pathname,
          contentType: request.headers["content-type"],
          body,
        });

        // An arbitrary method and a status most clients have never been asked to handle.
        if (request.method === "PROPFIND" && url.pathname === "/dav") {
          outgoing.writeHead(207, { "content-type": "application/xml", dav: "1, 2" });
          outgoing.end("<multistatus/>");
          return;
        }

        // Echoes the content type the codec produced, so a test can assert on it.
        if (url.pathname === "/echo") {
          sendJson(outgoing, 200, { contentType: request.headers["content-type"] ?? null, body });
          return;
        }

        // 503 with a Retry-After in the date form RFC 9110 also allows.
        if (url.pathname === "/warming-up") {
          warmUpAttempts += 1;
          if (warmUpAttempts < 3) {
            outgoing.writeHead(503, {
              "content-type": "application/json",
              "retry-after": new Date(Date.now() + 20).toUTCString(),
            });
            outgoing.end(JSON.stringify({ state: "warming" }));
            return;
          }
          sendJson(outgoing, 200, { state: "ready", attempts: warmUpAttempts });
          return;
        }

        // 420 Enhance Your Calm: unregistered, and used for rate limiting before 429.
        if (url.pathname === "/throttled") {
          throttleAttempts += 1;
          if (throttleAttempts < 3) {
            outgoing.writeHead(420, { "content-type": "application/json" });
            outgoing.end(JSON.stringify({ error: "enhance_your_calm", attempt: throttleAttempts }));
            return;
          }
          sendJson(outgoing, 200, { attempts: throttleAttempts });
          return;
        }

        // An error payload with no discriminant of any kind, which is what a service
        // that has never heard of Effect sends.
        if (url.pathname === "/untagged-error") {
          sendJson(outgoing, 409, { error: "conflict", error_description: "already exists" });
          return;
        }

        outgoing.writeHead(404);
        outgoing.end();
      };

      void handle();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("a request body codec owns the content type", () => {
    it("overrides a declared content-type header, because encoding runs afterwards", async () => {
      // Declaring `content-type` on the API looks like it should work and does not: the
      // declarative layer is materialized first, and then the body codec sets its own
      // media type on the encoded request. `RequestBody.text()` defaults to text/plain.
      const api = createApi(baseUrl, { headers: { "content-type": "application/xml" } });
      const send = api.createRequest({
        method: "POST",
        path: "/echo",
        body: Schema.String,
        bodyCodec: RequestBody.text(),
        responses: [
          response({ _tag: "ok", status: 200 }, Schema.Struct({ contentType: Schema.String, body: Schema.String })),
        ],
      });

      const result = await send()
        .setBody("<note/>")
        .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

      expect(result.body.contentType).toBe("text/plain");
      expect(result.body.body).toBe("<note/>");
    });

    it("is the codec's argument, not a header, that sets it", async () => {
      const api = createApi(baseUrl, { headers: { "content-type": "application/xml" } });
      const send = api.createRequest({
        method: "POST",
        path: "/echo",
        body: Schema.String,
        bodyCodec: RequestBody.text('application/soap+xml; action="urn:example/Do"'),
        responses: [
          response({ _tag: "ok", status: 200 }, Schema.Struct({ contentType: Schema.String, body: Schema.String })),
        ],
      });

      const result = await send()
        .setBody("<envelope/>")
        .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

      expect(result.body.contentType).toBe('application/soap+xml; action="urn:example/Do"');
    });

    it("removes it entirely for form data, so the boundary can be generated", async () => {
      const api = createApi(baseUrl, { headers: { "content-type": "application/xml" } });
      const send = api.createRequest({
        method: "POST",
        path: "/echo",
        body: Schema.instanceOf(FormData),
        bodyCodec: RequestBody.formData,
        responses: [
          response({ _tag: "ok", status: 200 }, Schema.Struct({ contentType: Schema.String, body: Schema.String })),
        ],
      });

      const form = new FormData();
      form.append("field", "value");
      const result = await send().setBody(form).effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

      expect(result.body.contentType).toMatch(/^multipart\/form-data; boundary=/u);
      expect(result.body.body).toContain('name="field"');
    });
  });

  it("honours a Retry-After expressed as an HTTP-date, not only as seconds", async () => {
    warmUpAttempts = 0;
    const api = createApi(baseUrl);
    const warmUp = api.createRequest({
      method: "GET",
      path: "/warming-up",
      responses: [
        response({ _tag: "ready", status: 200 }, Schema.Struct({ state: Schema.String, attempts: Schema.Number })),
      ],
    });

    const result = await warmUp().setRetries(3).effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(result.body.attempts).toBe(3);
  });

  describe("an unregistered status code", () => {
    it("is not transient by default, which is the correct default", async () => {
      throttleAttempts = 0;
      const api = createApi(baseUrl);
      const call = api.createRequest({
        method: "GET",
        path: "/throttled",
        responses: [
          response({ _tag: "ok", status: 200 }, Schema.Struct({ attempts: Schema.Number })),
          response({ _tag: "calm", status: 420 }, Schema.Struct({ error: Schema.String, attempt: Schema.Number })),
        ],
      });

      const result = await call().setRetries(3).effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

      // Three retries were available and none were spent: 420 is not in the built-in
      // transient set, and a library that guessed otherwise would be wrong more often
      // than it was right.
      expect(result._tag).toBe("calm");
      expect(throttleAttempts).toBe(1);
    });

    it("is retried when `while` adds it", async () => {
      throttleAttempts = 0;
      const api = createApi(baseUrl);
      const call = api.createRequest({
        method: "GET",
        path: "/throttled",
        responses: [
          response({ _tag: "ok", status: 200 }, Schema.Struct({ attempts: Schema.Number })),
          response({ _tag: "calm", status: 420 }, Schema.Struct({ error: Schema.String, attempt: Schema.Number })),
        ],
      });

      const result = await call()
        .setRetry({
          times: 4,
          while: (input) => typeof input === "object" && input !== null && "status" in input && input.status === 420,
        })
        .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

      expect(result._tag).toBe("ok");
      expect(throttleAttempts).toBe(3);
    });
  });

  it("sends an arbitrary method and maps an unusual status", async () => {
    const api = createApi(baseUrl);
    const propfind = api.createRequest({
      method: "PROPFIND",
      path: "/dav",
      headers: { depth: "1" },
      responses: [response({ _tag: "multiStatus", status: 207 }, Schema.String, { codec: ResponseBody.text })],
    });

    const result = await propfind().effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(result._tag).toBe("multiStatus");
    expect(result.status).toBe(207);
    expect(result.headers.dav).toBe("1, 2");
    expect(result.body).toBe("<multistatus/>");
  });

  describe("a response schema for a service that has never heard of Effect", () => {
    const Untagged = Schema.Struct({ error: Schema.String, error_description: Schema.String });

    it("cannot require a discriminant the service does not send", async () => {
      class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
        error: Schema.String,
        error_description: Schema.String,
      }) {}

      const api = createApi(baseUrl);
      const call = api.createRequest({
        method: "GET",
        path: "/untagged-error",
        responses: [response({ _tag: "conflict", status: 409 }, Conflict)],
      });

      const outcome = await call().effect.pipe(Effect.either, Effect.provide(FetchHttpClient.layer), Effect.runPromise);

      // `Schema.TaggedError` puts `_tag` on the *encoded* side, so it only decodes a
      // payload that carries one. That is right when both ends share the definition, and
      // impossible when the other end is a Rust service that has never heard of it.
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) expect(outcome.left._tag).toBe("ResponseDecodeError");
    });

    it("attaches one on decode instead, keeping the encoded shape the service sends", async () => {
      const Tagged = Untagged.pipe(Schema.attachPropertySignature("_tag", "Conflict"));

      const api = createApi(baseUrl);
      const call = api.createRequest({
        method: "GET",
        path: "/untagged-error",
        responses: [response({ _tag: "conflict", status: 409 }, Tagged)],
      });

      const result = await call().effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

      // Two discriminants, neither transmitted: the rule's tag came from the matcher and
      // the body's tag was attached by the schema. `Match.tag` works on both.
      expect(result._tag).toBe("conflict");
      expect(result.body._tag).toBe("Conflict");
      expect(Schema.encodeSync(Tagged)(result.body)).toEqual({
        error: "conflict",
        error_description: "already exists",
      });
    });
  });

  it("computes a header from the encoded body through mapClient, per attempt", async () => {
    // A computed header value cannot do this: it takes no arguments and resolves while
    // the request is materialized, before the body schema has encoded anything.
    // `mapClient` wraps the client, so it runs after encoding and again on every attempt.
    let signatures: Array<string> = [];
    const api = createApi(baseUrl);
    const send = api.createRequest({
      method: "POST",
      path: "/echo",
      body: Schema.Struct({ note: Schema.String }),
      responses: [
        response({ _tag: "ok", status: 200 }, Schema.Struct({ contentType: Schema.String, body: Schema.String })),
      ],
    });

    const signing = HttpClient.mapRequestEffect((request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const payload =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode((request.body as unknown as { readonly body: Uint8Array }).body)
            : "";
        const signature = `len:${payload.length}`;
        signatures.push(signature);
        return HttpClientRequest.setHeader(request, "x-signature", signature);
      }),
    );

    signatures = [];
    const result = await send()
      .setBody({ note: "hello" })
      .mapClient(signing)
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(result._tag).toBe("ok");
    expect(signatures).toEqual([`len:${JSON.stringify({ note: "hello" }).length}`]);
    expect(observed.at(-1)?.body).toBe(JSON.stringify({ note: "hello" }));
  });
});
