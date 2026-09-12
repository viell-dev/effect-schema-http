import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createRequest,
  RequestBody,
  RequestBodyRequired,
  response,
  ResponseBody,
  SchemaHttp,
  toEffect,
  UrlEncoding,
} from "../main.js";

const clientFor = (handler: (request: Parameters<HttpClient.HttpClient["execute"]>[0]) => Response) =>
  HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request))));

describe("Effect-native contracts", () => {
  it("inherits service defaults and replaces encoding without changing endpoint declarations", async () => {
    const layer = SchemaHttp.layer({ headers: { "x-source": "service" } }).pipe(
      Layer.provide(UrlEncoding.layer({ pathParameter: (value) => value })),
    );
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* SchemaHttp;
        return http.createApi("https://example.com").createRequest({
          method: "GET",
          path: "/items/:id",
          responses: [response({ _tag: "ok", status: 200 }, ResponseBody.text)],
        });
      }).pipe(Effect.provide(layer)),
    );
    const value = await Effect.runPromise(
      endpoint({ id: "a;b" }).effect.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor((request) => {
            expect(request.url).toBe("https://example.com/items/a;b");
            expect(request.headers["x-source"]).toBe("service");
            return new Response("plain text");
          }),
        ),
      ),
    );
    expectTypeOf(value.body).toEqualTypeOf<string>();
    expect(value.body).toBe("plain text");
  });

  it("encodes selected header/query schemas and rejects unchecked domain input before sending", async () => {
    const endpoint = createRequest({
      method: "GET",
      path: "https://example.com/items",
      headersSchema: Schema.Struct({ "x-limit": Schema.NumberFromString }),
      urlParamsSchema: Schema.Struct({ page: Schema.NumberFromString, tags: Schema.Array(Schema.String) }),
      responses: [response({ _tag: "ok", status: 200 }, ResponseBody.text)],
    });
    const plan = endpoint()
      .setHeaders({ "x-limit": 4 })
      .setUrlParams({ page: 2, tags: ["a", "b"] });
    let sends = 0;
    const client = clientFor((request) => {
      sends++;
      expect(request.headers["x-limit"]).toBe("4");
      expect(request.url).toBe("https://example.com/items?page=2&tags=a&tags=b");
      return new Response("ok");
    });
    expect(
      (await Effect.runPromise(plan.pipe(toEffect, Effect.provideService(HttpClient.HttpClient, client)))).body,
    ).toBe("ok");
    const invalid = await Effect.runPromise(
      plan
        .setUrlParams({ page: "2", tags: [] } as never)
        .effect.pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(Either.isLeft(invalid) && invalid.left._tag).toBe("RequestFieldsEncodeError");
    expect(sends).toBe(1);
    expect(() => {
      // @ts-expect-error A selected schema owns the collection; raw field setters cannot bypass it.
      plan.setUrlParam("page", "2");
    }).toThrow(TypeError);
    const checkTypes = () => {
      // @ts-expect-error Numeric application input is required.
      endpoint().setHeaders({ "x-limit": "4" });
      // @ts-expect-error The schema's encoded fields must be serializable HTTP values.
      createRequest({ method: "GET", path: "/", headersSchema: Schema.Struct({ number: Schema.Number }) });
    };
    void checkTypes;
  });

  it("propagates schema service requirements", async () => {
    class Prefix extends Context.Tag("test/Prefix")<Prefix, string>() {}
    const field = Schema.transformOrFail(Schema.String, Schema.String, {
      decode: (value) => Effect.succeed(value),
      encode: (value) => Effect.map(Prefix, (prefix) => `${prefix}${value}`),
    });
    const endpoint = createRequest({
      method: "GET",
      path: "https://example.com",
      urlParamsSchema: Schema.Struct({ name: field }),
      responses: [response({ _tag: "ok", status: 200 }, ResponseBody.text)],
    });
    const plan = endpoint().setUrlParams({ name: "Ada" });
    expectTypeOf<Effect.Effect.Context<typeof plan.effect>>().toEqualTypeOf<HttpClient.HttpClient | Prefix>();
    const result = await Effect.runPromise(
      plan.effect.pipe(
        Effect.provideService(Prefix, "prefix-"),
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor((request) => new Response(request.url)),
        ),
      ),
    );
    expect(result.body).toContain("name=prefix-Ada");
  });

  it("supports codec-only binary uploads/downloads while preserving body readiness", async () => {
    const endpoint = createRequest({
      method: "POST",
      path: "https://example.com/image",
      body: RequestBody.uint8Array("image/png"),
      responses: [response({ _tag: "ok", status: 200 }, ResponseBody.uint8Array)],
    });
    const incomplete = endpoint();
    const checkTypes = () => {
      expectTypeOf(incomplete.effect).toEqualTypeOf<RequestBodyRequired>();
      // @ts-expect-error A byte codec accepts bytes, not an arbitrary string.
      incomplete.setBody("png");
    };
    void checkTypes;
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const result = await Effect.runPromise(
      incomplete.setBody(bytes).effect.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor((request) => {
            expect(request.body._tag).toBe("Uint8Array");
            expect(request.headers["content-type"]).toBe("image/png");
            return new Response(bytes);
          }),
        ),
      ),
    );
    expectTypeOf(result.body).toExtend<Uint8Array>();
    expect(result.body).toEqual(bytes);
  });
  it("distinguishes an explicit undefined schema value from omitted field input", async () => {
    let reads = 0;
    const headersSchema = Schema.transform(Schema.Struct({}), Schema.Undefined, {
      decode: () => undefined,
      encode: () => ({}),
    });
    const endpoint = createRequest(
      {
        method: "GET",
        path: "https://example.com",
        headersSchema,
        responses: [response({ _tag: "ok", status: 200 }, ResponseBody.text)],
      },
      { headers: { inherited: () => String(++reads) } },
    );
    const result = await Effect.runPromise(
      endpoint()
        .setHeaders(undefined)
        .effect.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            clientFor((request) => {
              expect(request.headers["inherited"]).toBeUndefined();
              return new Response("ok");
            }),
          ),
        ),
    );
    expect(result.body).toBe("ok");
    expect(reads).toBe(0);
  });
});
