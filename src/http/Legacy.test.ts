import { createHmac } from "node:crypto";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect, Either, Schema, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { Body, Operation, Policy, Request, Response, Transport } from "../main.js";

const root = "https://legacy.example.test";
const reply = (
  request: HttpClientRequest.HttpClientRequest,
  value: string,
  status = 200,
  headers?: Record<string, string>,
) => HttpClientResponse.fromWeb(request, new globalThis.Response(value, { status, headers }));

describe("protocol edge cases identified in the polyglot evaluation", () => {
  it("preserves bare keys, empty values, repetition, and native query replacements", async () => {
    const source = Request.get(`${root}/service?wsdl&empty=&wsdl`);
    expect((await Effect.runPromise(Request.materialize(source, undefined))).url).toBe(
      `${root}/service?wsdl&wsdl&empty=`,
    );
    const changed = source.pipe(
      Request.setQuery("wsdl", null),
      Request.appendQuery("wsdl", ""),
      Request.setQuery("computed", () => null),
    );
    expect((await Effect.runPromise(Request.materialize(changed, undefined))).url).toBe(
      `${root}/service?wsdl&wsdl=&empty=&computed`,
    );
    const explicitEmpty = Request.get(`${root}/service?wsdl`).pipe(
      Request.mapEffect((request) => Effect.succeed(HttpClientRequest.setUrlParam(request, "wsdl", ""))),
    );
    expect((await Effect.runPromise(Request.materialize(explicitEmpty, undefined))).url).toBe(`${root}/service?wsdl=`);
    const typed = Request.get(root).pipe(
      Request.query(Schema.Struct({ wsdl: Schema.Null, q: Schema.Array(Schema.String) })),
    );
    expect((await Effect.runPromise(Request.materialize(typed, { query: { wsdl: null, q: ["a", "b"] } }))).url).toBe(
      `${root}?wsdl&q=a&q=b`,
    );
  });

  it("exposes lossless request header lines through a native per-evaluation service", async () => {
    const client = HttpClient.make((request) =>
      Effect.map(Transport.headerLines(request), (lines) => {
        expect(lines.filter(([name]) => name === "x-scope")).toEqual([
          ["x-scope", "openid"],
          ["x-scope", "projects:read"],
        ]);
        expect(lines.filter(([name]) => name === "authorization")).toEqual([["authorization", "signed"]]);
        return reply(request, "ok");
      }),
    );
    const operation = Operation.make(
      Request.get(root).pipe(
        Request.appendHeader("X-Scope", "openid"),
        Request.appendHeader("x-scope", "projects:read"),
        Request.setHeader("authorization", "old"),
      ),
      Response.status(200, Body.text),
      { transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "signed")) },
    );
    expect(
      await Effect.runPromise(operation.execute(undefined).pipe(Effect.provideService(HttpClient.HttpClient, client))),
    ).toBe("ok");
  });

  it("signs the actual encoded bytes with a fresh nonce on each attempt", async () => {
    let nonce = 0;
    let computed = 0;
    const bodies: Array<string> = [];
    const sign = HttpClient.mapRequestEffect((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected replayable bytes");
        const sequence = String(++nonce);
        const signature = createHmac("sha256", "test-key").update(sequence).update(request.body.body).digest("hex");
        return HttpClientRequest.setHeaders(request, { "x-nonce": sequence, "x-signature": signature });
      }),
    );
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected body bytes");
        bodies.push(new TextDecoder().decode(request.body.body));
        expect(request.headers["x-signature"]).toBe(
          createHmac("sha256", "test-key").update(request.headers["x-nonce"]).update(request.body.body).digest("hex"),
        );
        expect(request.headers.authorization).toBe("snapshot-1");
        return reply(request, "ok", nonce === 1 ? 420 : 200);
      }),
    );
    const operation = Operation.make(
      Request.post(root).pipe(
        Request.setHeader("authorization", () => `snapshot-${++computed}`),
        Request.body(Body.jsonSchema(Schema.Struct({ count: Schema.NumberFromString }))),
      ),
      Response.when(() => true, Body.text),
      {
        transformClient: sign,
        policy: Policy.make(Schedule.recurs(1), {
          while: (reason) => Policy.transient(reason) || reason.metadata?.status === 420,
        }),
      },
    );
    await Effect.runPromise(
      operation.execute({ body: { count: 42 } }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(nonce).toBe(2);
    expect(computed).toBe(1);
    expect(bodies).toEqual(['{"count":"42"}', '{"count":"42"}']);
  });

  it("selects header-signaled errors on 200 before touching the body", async () => {
    let reads = 0;
    const contract = Response.when(
      ({ status, headers }) => status === 200 && headers["x-error-code"] !== undefined,
      Response.tag("BusinessError", Body.text),
    ).pipe(
      Response.orElse(
        Response.status(
          200,
          Body.decoder(() => {
            reads++;
            return Effect.succeed("wrong decoder");
          }),
        ),
      ),
    );
    const raw = reply(HttpClientRequest.get(root), "denied", 200, { "x-error-code": "DENIED" });
    expect(await Effect.runPromise(Response.decode(contract, raw))).toMatchObject({
      _tag: "BusinessError",
      value: "denied",
    });
    expect(reads).toBe(0);
  });

  it("keeps Latin-1 bytes intact and lets a custom codec own SOAP content type", async () => {
    const wire = Body.make({
      encode: (value: string) => Effect.succeed(HttpBody.text(value, 'application/soap+xml; action="urn:Legacy"')),
      decode: (response) => response.text,
    });
    const request = Request.post(root).pipe(Request.setHeader("content-type", "application/json"), Request.body(wire));
    const prepared = await Effect.runPromise(Request.materialize(request, { body: "<Envelope/>" }));
    expect(prepared.headers["content-type"]).toBe('application/soap+xml; action="urn:Legacy"');
    const latin1 = Body.bytes.pipe(
      Body.map((bytes) => new TextDecoder("iso-8859-1").decode(bytes)),
      Body.schema(Schema.String),
    );
    const raw = HttpClientResponse.fromWeb(prepared, new globalThis.Response(new Uint8Array([82, 101, 110, 233, 101])));
    expect(await Effect.runPromise(latin1.decode(raw))).toBe("Renée");
  });

  it("supports custom methods, method tunneling, and service-specific large-integer parsers", async () => {
    const custom = await Effect.runPromise(Request.materialize(Request.make("PROPFIND", root), undefined));
    expect(custom.method).toBe("PROPFIND");
    const tunnel = Request.make("DELETE", root).pipe(
      Request.mapEffect((request) =>
        Effect.succeed(
          request.pipe(
            HttpClientRequest.setHeader("x-http-method-override", request.method),
            HttpClientRequest.setMethod("POST"),
          ),
        ),
      ),
    );
    expect((await Effect.runPromise(Request.materialize(tunnel, undefined))).headers["x-http-method-override"]).toBe(
      "DELETE",
    );
    // Parse the service's bare decimal representation before Number can lose precision.
    const large = Body.text.pipe(Body.schema(Schema.BigInt));
    expect(await Effect.runPromise(large.decode(reply(custom, "9007199254740993", 207)))).toBe(9007199254740993n);
  });

  it("handles no-body 200, HEAD facts, and conditional 304 without inventing JSON", async () => {
    for (const status of [200, 304]) {
      const raw = HttpClientResponse.fromWeb(
        HttpClientRequest.get(root),
        new globalThis.Response(null, { status, headers: { "content-type": "application/json" } }),
      );
      expect(await Effect.runPromise(Response.decode(Response.status(status, Body.empty), raw))).toBeUndefined();
    }
    const raw = HttpClientResponse.fromWeb(
      HttpClientRequest.head(root),
      new globalThis.Response(null, { headers: { "x-count": "7" } }),
    );
    const decoder = Body.decoder((response) =>
      Effect.zipRight(
        Body.empty.decode(response),
        Schema.decodeUnknown(Schema.Struct({ "x-count": Schema.NumberFromString }))(response.headers),
      ),
    );
    expect(await Effect.runPromise(decoder.decode(raw))).toEqual({ "x-count": 7 });
  });

  it("decodes payload-level alternatives under identical metadata", async () => {
    const schema = Schema.Union(
      Schema.Struct({ result: Schema.String }).pipe(Schema.attachPropertySignature("_tag", "Success")),
      Schema.Struct({ fault: Schema.String }).pipe(Schema.attachPropertySignature("_tag", "Fault")),
    );
    const contract = Response.status(200, Body.jsonSchema(schema));
    expect(
      await Effect.runPromise(Response.decode(contract, reply(HttpClientRequest.get(root), '{"fault":"denied"}'))),
    ).toEqual({ _tag: "Fault", fault: "denied" });
    const invalid = await Effect.runPromise(
      Effect.either(Response.decode(contract, reply(HttpClientRequest.get(root), '{"unrelated":true}'))),
    );
    expect(Either.isLeft(invalid) && invalid.left._tag).toBe("DecodeError");
  });
});
