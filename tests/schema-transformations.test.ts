import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Either, ParseResult, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  createApi,
  RequestBody,
  RequestBodyEncodeError,
  response,
  ResponseBody,
  ResponseDecodeError,
} from "../src/main.js";

const NonNegativeIntegerBrand = Symbol.for("schema-http/tests/NonNegativeInteger");
const NonNegativeInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.brand(NonNegativeIntegerBrand),
  Schema.asSchema,
);
type NonNegativeInteger = typeof NonNegativeInteger.Type;

const Version = Schema.Struct({
  name: Schema.Literal("Example API"),
  major: NonNegativeInteger,
  minor: NonNegativeInteger,
  build: NonNegativeInteger,
});
const VersionFromString = Schema.parseJson(Version);

const RequestXmlString = Schema.String.pipe(Schema.filter((value) => /^<command>[a-z-]+<\/command>$/.test(value)));
const XmlAcknowledgement = Schema.transformOrFail(Schema.String, Schema.Struct({ accepted: Schema.Boolean }), {
  strict: true,
  decode: (input, _, ast) =>
    input === "<accepted>true</accepted>"
      ? ParseResult.succeed({ accepted: true })
      : ParseResult.fail(new ParseResult.Type(ast, input)),
  encode: ({ accepted }) => ParseResult.succeed(`<accepted>${String(accepted)}</accepted>`),
});
const EmptyAcknowledgement = Schema.transform(Schema.Undefined, Schema.Literal("accepted"), {
  strict: true,
  decode: () => "accepted" as const,
  encode: () => undefined,
});

type JsonValue = null | string | number | boolean | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };

const JsonValueSchema: Schema.Schema<JsonValue> = Schema.Union(
  Schema.Null,
  Schema.String,
  Schema.JsonNumber,
  Schema.Boolean,
  Schema.suspend((): Schema.Schema<ReadonlyArray<JsonValue>> => Schema.Array(JsonValueSchema)),
  Schema.suspend((): Schema.Schema<{ readonly [key: string]: JsonValue }> =>
    Schema.Record({ key: Schema.String, value: JsonValueSchema }),
  ),
);

const readText = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (outgoing: ServerResponse, status: number, body: unknown): void => {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
};

describe("schema transformations over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let requests = 0;

  beforeAll(async () => {
    server = createServer((request, outgoing) => {
      const handle = async () => {
        requests += 1;
        const url = new URL(request.url ?? "/", "http://localhost");

        if (request.method === "GET" && url.pathname === "/") {
          sendJson(outgoing, 200, { name: "Example API", major: 1, minor: 4, build: 0 });
          return;
        }
        if (request.method === "GET" && url.pathname === "/version-text") {
          outgoing.writeHead(200, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ name: "Example API", major: 1, minor: 4, build: 0 }));
          return;
        }
        if (request.method === "GET" && url.pathname === "/invalid-version") {
          sendJson(outgoing, 200, { name: "Example API", major: -1, minor: 4, build: 0 });
          return;
        }
        if (request.method === "GET" && url.pathname === "/recursive-json") {
          sendJson(outgoing, 200, { items: [1, true, null, { nested: ["value"] }] });
          return;
        }
        if (request.method === "POST" && url.pathname === "/commands") {
          const body = await readText(request);
          if (request.headers["content-type"] !== "application/xml" || body !== "<command>archive</command>") {
            sendJson(outgoing, 400, { error: "invalid request" });
            return;
          }
          outgoing.writeHead(202, { "content-type": "application/xml" });
          outgoing.end("<accepted>true</accepted>");
          return;
        }
        if (request.method === "POST" && url.pathname === "/empty-acknowledgement") {
          outgoing.writeHead(204);
          outgoing.end();
          return;
        }

        sendJson(outgoing, 404, { error: "not found" });
      };

      handle().catch((error: unknown) => sendJson(outgoing, 500, { error: String(error) }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    requests = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it("decodes a root response into nested branded values through JSON or text", async () => {
    const api = createApi(baseUrl);
    const getVersion = api.createRequest({
      method: "GET",
      path: "/",
      responses: [response({ key: "version", status: 200 }, Version)],
    });
    const getVersionFromString = api.createRequest({
      method: "GET",
      path: "/version-text",
      responseCodec: ResponseBody.text,
      responses: [response({ key: "version", status: 200 }, VersionFromString)],
    });

    const json = await getVersion().effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    const text = await getVersionFromString().effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(json.body).toEqual({ name: "Example API", major: 1, minor: 4, build: 0 });
    expect(text.body).toEqual(json.body);
    expectTypeOf(json.body.major).toEqualTypeOf<NonNegativeInteger>();
    expectTypeOf(text.body.major).toEqualTypeOf<NonNegativeInteger>();
    expect("response" in json).toBe(false);
  });

  it("reports response transformation failures with matcher and response context", async () => {
    const getInvalidVersion = createApi(baseUrl).createRequest({
      method: "GET",
      path: "/invalid-version",
      responses: [response({ key: "version", status: 200 }, Version)],
    });

    const result = await getInvalidVersion().effect.pipe(
      Effect.either,
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ResponseDecodeError);
      if (result.left instanceof ResponseDecodeError) {
        expect(result.left.key).toBe("version");
        expect(result.left.status).toBe(200);
        expect(ParseResult.isParseError(result.left.cause)).toBe(true);
      }
    }
  });

  it("allows schemas to own fallible XML request encoding and response parsing", async () => {
    const sendCommand = createApi(baseUrl).createRequest({
      method: "POST",
      path: "/commands",
      body: RequestXmlString,
      bodyCodec: RequestBody.text("application/xml"),
      responses: [response({ key: "accepted", status: 202 }, XmlAcknowledgement, { codec: ResponseBody.text })],
    });

    const accepted = await sendCommand()
      .setBody("<command>archive</command>")
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    const beforeInvalid = requests;
    const invalid = await sendCommand()
      .setBody("not xml")
      .effect.pipe(Effect.either, Effect.provide(FetchHttpClient.layer), Effect.runPromise);

    expect(accepted.body).toEqual({ accepted: true });
    expect(Either.isLeft(invalid)).toBe(true);
    if (Either.isLeft(invalid)) expect(invalid.left).toBeInstanceOf(RequestBodyEncodeError);
    expect(requests).toBe(beforeInvalid);
  });

  it("decodes no-body responses into a domain value from undefined input", async () => {
    const acknowledge = createApi(baseUrl).createRequest({
      method: "POST",
      path: "/empty-acknowledgement",
      responses: [response({ key: "accepted", status: 204 }, EmptyAcknowledgement, { codec: ResponseBody.none })],
    });

    const result = await acknowledge().effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(result).toMatchObject({ key: "accepted", body: "accepted" });
  });

  it("validates recursive JSON values through a real response", async () => {
    const getJson = createApi(baseUrl).createRequest({
      method: "GET",
      path: "/recursive-json",
      responses: [response({ key: "json", status: 200 }, JsonValueSchema)],
    });

    const result = await getJson().effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(result.body).toEqual({ items: [1, true, null, { nested: ["value"] }] });
    expect(Schema.is(JsonValueSchema)(result.body)).toBe(true);
  });
});
