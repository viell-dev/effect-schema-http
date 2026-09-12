import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type BodyNotReady,
  createRequest,
  RequestBody,
  response,
  ResponseBody,
  SchemaHttp,
  toEffect,
  UrlEncoding,
  type RequestOptions,
} from "../main.js";

const clientFor = (handler: (request: Parameters<HttpClient.HttpClient["execute"]>[0]) => Response) =>
  HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request))));

describe("Effect-native contracts", () => {
  it("composes service factory overrides with shared defaults and endpoint options lazily", async () => {
    const events: string[] = [];
    let reads = 0;
    const transforms = (name: string): RequestOptions => ({
      transformRequest: (request) => {
        events.push(`request:${name}`);
        return request;
      },
      transformClient: (client) => {
        events.push(`client:${name}`);
        return client;
      },
    });
    const endpoints = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* SchemaHttp;
        const overrides = {
          ...transforms("override"),
          headers: { "x-tenant": "acme" },
          urlParams: { page: "2" },
          retries: 0,
        };
        const definition = {
          ...transforms("endpoint"),
          method: "GET",
          path: "/items",
          removeHeaders: ["x-remove"],
          removeUrlParams: ["removed"],
          responses: [response({ _tag: "unavailable", status: 503 }, ResponseBody.text)],
        } as const;
        const standalone = http.createRequest({ ...definition, path: "https://example.com/items" }, overrides);
        const fromApi = http.createApi("https://example.com", overrides).createRequest(definition);
        const inheritedRules = http
          .createApi("https://example.com", {
            responses: definition.responses,
          })
          .createRequest({ method: "GET", path: "/items" });
        expectTypeOf<
          Effect.Effect.Success<ReturnType<typeof inheritedRules>["effect"]>["_tag"]
        >().toEqualTypeOf<"unavailable">();
        return [standalone, fromApi];
      }).pipe(
        Effect.provide(
          SchemaHttp.layer({
            ...transforms("service"),
            headers: {
              authorization: () => `Bearer ${++reads}`,
              "x-remove": () => {
                throw new Error("removed header evaluated");
              },
            },
            urlParams: {
              lang: "en",
              page: "1",
              removed: () => {
                throw new Error("removed query evaluated");
              },
            },
            retry: { times: 1 },
          }).pipe(Layer.provide(UrlEncoding.Default)),
        ),
      ),
    );
    expect(reads).toBe(0);
    expect(events).toEqual([]);
    let sends = 0;
    for (const endpoint of endpoints) {
      const effect = endpoint().effect;
      expect(events).toEqual([]);
      const value = await Effect.runPromise(
        effect.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            clientFor((request) => {
              sends++;
              expect(request.headers["authorization"]).toBe(`Bearer ${sends}`);
              expect(request.headers["x-tenant"]).toBe("acme");
              expect(request.headers["x-remove"]).toBeUndefined();
              expect(request.url).toBe("https://example.com/items?page=2&lang=en");
              return new Response("unavailable", { status: 503 });
            }),
          ),
        ),
      );
      expect(value._tag).toBe("unavailable");
      expect(events).toEqual([
        "request:service",
        "request:override",
        "request:endpoint",
        "client:service",
        "client:override",
        "client:endpoint",
      ]);
      events.length = 0;
    }
    expect(sends).toBe(2);
    expect(reads).toBe(2);
  });

  it("lets field schemas retain inherited credentials or reject excess defaults before sending", async () => {
    let reads = 0;
    let sends = 0;
    const defaults = { headers: { authorization: () => `Bearer ${++reads}` } };
    const definition = {
      method: "GET",
      path: "https://example.com",
      headers: { "x-tenant": "acme" },
      responses: [response({ _tag: "ok", status: 200 }, ResponseBody.text)],
    } as const;
    const strictSchema = Schema.Struct({ "x-tenant": Schema.String }).annotations({
      parseOptions: { onExcessProperty: "error" },
    });
    const strict = createRequest({ ...definition, headersSchema: strictSchema }, defaults);
    const client = clientFor((request) => {
      sends++;
      expect(request.headers["authorization"]).toBe("Bearer 2");
      expect(request.headers["x-tenant"]).toBe("acme");
      return new Response("ok");
    });
    const failure = await Effect.runPromise(
      strict().effect.pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(Either.isLeft(failure) && failure.left._tag).toBe("RequestFieldsEncodeError");
    expect(sends).toBe(0);

    const modeled = createRequest(
      {
        ...definition,
        headersSchema: Schema.Struct({ "x-tenant": Schema.String, authorization: Schema.optional(Schema.String) }),
      },
      defaults,
    );
    await Effect.runPromise(modeled().effect.pipe(Effect.provideService(HttpClient.HttpClient, client)));
    expect(sends).toBe(1);
  });

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
      expectTypeOf(incomplete.effect).toEqualTypeOf<BodyNotReady>();
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
