import { FetchHttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Either, Layer, Match, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createApi,
  createRequest,
  DuplicateResponseKey,
  InvalidPathArguments,
  RequestBodyNotAllowed,
  response,
  ResponseBody,
  type Endpoint,
  UnhandledResponse,
} from "./main.js";

const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
const ThinUser = Schema.Struct({ id: Schema.Number });
const NotFound = Schema.Struct({ message: Schema.String });
const DetailedNotFound = Schema.Struct({ message: Schema.String, resource: Schema.String });
const Gone = Schema.Struct({ deletedAt: Schema.String });

const fetchLayer = (handler: typeof fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, handler)));

const mockFetch = (handler: (request: Request) => Promise<Response>): typeof fetch =>
  ((input: URL | RequestInfo, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(input, init))) as typeof fetch;

describe("createRequest", () => {
  it("infers, validates, and encodes placeholders anywhere in a path", async () => {
    const getFile = createRequest({
      method: "GET",
      path: "https://example.test/v:version/files/:name.:ext",
      responses: [response({ key: "post", status: 200 }, Schema.Struct({ id: Schema.String }))] as const,
    });

    expectTypeOf(getFile).parameters.toEqualTypeOf<[value: string, value: string, value: string]>();

    const result = await getFile("2", "report name", "json").effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(request.url).toBe("https://example.test/v2/files/report%20name.json");
            return Response.json({ id: "report name" });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result.body.id).toBe("report name");

    const untypedGetFile = getFile as (...arguments_: Array<string>) => ReturnType<typeof getFile>;
    expect(() => untypedGetFile("2", "report")).toThrow(InvalidPathArguments);
  });

  it("merges plural URL parameter updates over API and endpoint defaults", async () => {
    const getUsers = createApi("https://example.test", {
      urlParams: { apiKey: "k", page: "1" },
    }).createRequest({
      method: "GET",
      path: "/users",
      urlParams: { locale: "sv" },
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))] as const,
    });

    await getUsers()
      .setUrlParams({ page: "2" })
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              const url = new URL(request.url);
              expect(url.pathname).toBe("/users");
              expect(Object.fromEntries(url.searchParams)).toEqual({ apiKey: "k", page: "2", locale: "sv" });
              return Response.json([]);
            }),
          ),
        ),
        Effect.runPromise,
      );
  });

  it("rejects GET and HEAD bodies at the definition and transformed-request boundaries", async () => {
    createRequest({
      method: "GET",
      path: "https://example.test/users",
      // @ts-expect-error Fetch does not support GET request bodies.
      body: Schema.Struct({ probe: Schema.Boolean }),
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))] as const,
    });

    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))] as const,
    });
    const result = await getUsers()
      .mapRequest(HttpClientRequest.bodyUnsafeJson({ probe: true }))
      .effect.pipe(
        Effect.either,
        Effect.provide(
          fetchLayer(
            mockFetch(async () => {
              throw new Error("Fetch should not be reached");
            }),
          ),
        ),
        Effect.runPromise,
      );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RequestBodyNotAllowed);
  });

  it("is lazy and replaces only the response rule with the same matcher", async () => {
    const requests: Array<Request> = [];
    const api = createApi("https://example.test", {
      headers: { authorization: "Bearer token" },
      responses: [response({ key: "not-found", status: 404 }, NotFound)] as const,
    });
    const getUsers = api.createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))] as const,
    });

    const plan = getUsers()
      .setUrlParam("fields", "id")
      .setResponseSchema({ key: "ok", status: 200 }, Schema.Array(ThinUser));

    expect(requests).toEqual([]);

    const result = await plan.effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            requests.push(request);
            return Response.json([{ id: 1 }], { status: 200 });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result).toMatchObject({ status: 200, body: [{ id: 1 }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.test/users?fields=id");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token");

    if (result.status === 200) {
      expectTypeOf(result.body).toEqualTypeOf<ReadonlyArray<typeof ThinUser.Type>>();
    } else {
      expectTypeOf(result.body).toEqualTypeOf<typeof NotFound.Type>();
    }
  });

  it("keeps API and endpoint response rule order aligned in the endpoint type", () => {
    const defaultRule = response({ key: "default", status: 404 }, NotFound);
    const firstRule = response({ key: "first", status: 200 }, User);
    const secondRule = response({ key: "second", status: 201 }, User);
    const endpoint = createApi("https://example.test", { responses: [defaultRule] }).createRequest({
      method: "GET",
      path: "/users",
      responses: [firstRule, secondRule],
    });
    type RulesOf<Value> = Value extends Endpoint<string, infer _Body, infer Rules, boolean> ? Rules : never;

    expectTypeOf<RulesOf<typeof endpoint>>().toEqualTypeOf<
      readonly [typeof firstRule, typeof secondRule, typeof defaultRule]
    >();
  });

  it("rejects duplicate response keys in declarations", () => {
    const duplicateRules = [
      response({ key: "same", status: 200 }, User),
      response({ key: "same", status: 201 }, User),
    ] as const;

    expect(() =>
      createRequest({
        method: "GET",
        path: "https://example.test/users",
        // @ts-expect-error Response keys must be unique within one declaration.
        responses: duplicateRules,
      }),
    ).toThrow(DuplicateResponseKey);
  });

  it("matches status and headers with predicates and exposes the raw response", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [
        response(
          {
            key: "json",
            status: (status) => status >= 200 && status < 300,
            headers: { "content-type": (value) => value?.startsWith("application/json") ?? false },
          },
          User,
        ),
        response({ key: "success", status: (status) => status >= 200 && status < 300 }, User),
      ],
    });

    const result = await getUser().effect.pipe(
      Effect.provide(
        fetchLayer(mockFetch(async () => Response.json({ id: 1, name: "Ada" }, { headers: { "x-extra": "kept" } }))),
      ),
      Effect.runPromise,
    );

    expect(result.key).toBe("json");
    expect(result.status).toBe(200);
    expect(result.response.headers["x-extra"]).toBe("kept");
  });

  it("uses declaration order for ties and lets a new plan rule take precedence", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ key: "first", status: 200 }, User), response({ key: "second", status: 200 }, User)],
    });
    const layer = fetchLayer(mockFetch(async () => Response.json({ id: 1, name: "Ada" })));

    const declared = await getUser().effect.pipe(Effect.provide(layer), Effect.runPromise);
    const overridden = await getUser()
      .setResponseSchema({ key: "plan", status: 200 }, User)
      .effect.pipe(Effect.provide(layer), Effect.runPromise);

    expect(declared.key).toBe("first");
    expect(overridden.key).toBe("plan");
  });

  it("decodes text and drains no-body responses before decoding undefined", async () => {
    const getStatus = createRequest({
      method: "GET",
      path: "https://example.test/status",
      responses: [response({ key: "ok", status: 200 }, Schema.Literal("ready"), { codec: ResponseBody.text })],
    });
    const trigger = createRequest({
      method: "POST",
      path: "https://example.test/trigger",
      responses: [response({ key: "done", status: 202 }, Schema.Void, { codec: ResponseBody.none })],
    });

    const text = await getStatus().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => new Response("ready")))),
      Effect.runPromise,
    );
    const none = await trigger().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => new Response("discarded", { status: 202 })))),
      Effect.runPromise,
    );

    expect(text.body).toBe("ready");
    expect(none.body).toBeUndefined();

    response(
      { key: "invalid", status: 204 },
      User,
      // @ts-expect-error A no-body codec requires a schema whose output accepts undefined.
      { codec: ResponseBody.none },
    );
  });

  it("keeps mapped 4xx responses in the success channel", async () => {
    const api = createApi("https://example.test", {
      responses: [
        response({ key: "not-found", status: 404 }, NotFound),
        response({ key: "gone", status: 410 }, Gone),
      ] as const,
    });
    const getUser = api.createRequest({
      method: "GET",
      path: "/users/1",
      responses: [response({ key: "ok", status: 200 }, User)] as const,
    });

    const result = await getUser().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => Response.json({ deletedAt: "2026-09-09" }, { status: 410 })))),
      Effect.runPromise,
    );

    expect(result).toMatchObject({ status: 410, body: { deletedAt: "2026-09-09" } });
    if (result.status === 410) expectTypeOf(result.body).toEqualTypeOf<typeof Gone.Type>();
    const description = Match.value(result).pipe(
      Match.when({ key: "ok" }, ({ body }) => body.name),
      Match.when({ key: "not-found" }, ({ body }) => body.message),
      Match.when({ key: "gone" }, ({ body }) => body.deletedAt),
      Match.exhaustive,
    );
    expect(description).toBe("2026-09-09");

    const getDetailedUser = api.createRequest({
      method: "GET",
      path: "/detailed-users/1",
      responses: [response({ key: "not-found", status: 404 }, DetailedNotFound)] as const,
    });
    const detailed = await getDetailedUser().effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async () => Response.json({ message: "missing", resource: "detailed-user" }, { status: 404 })),
        ),
      ),
      Effect.runPromise,
    );

    expect(detailed.body).toEqual({ message: "missing", resource: "detailed-user" });
    if (detailed.status === 404) expectTypeOf(detailed.body).toEqualTypeOf<typeof DetailedNotFound.Type>();
  });

  it("sets and schema-encodes request bodies after creating a zero-argument plan", async () => {
    const createUser = createRequest({
      method: "POST",
      path: "https://example.test/users",
      body: Schema.Struct({ name: Schema.String }),
      responses: [response({ key: "created", status: 201 }, User)] as const,
    });

    const plan = createUser();
    expectTypeOf(plan.setBody).parameter(0).toEqualTypeOf<{ readonly name: string }>();
    expectTypeOf(plan.effect).toEqualTypeOf<never>();

    const result = await plan.setBody({ name: "Ada" }).effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(await request.json()).toEqual({ name: "Ada" });
            return Response.json({ id: 1, name: "Ada" }, { status: 201 });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result.body.name).toBe("Ada");
  });

  it("can execute with a schema-encoded static body and override it through the setter", async () => {
    const bodies: Array<unknown> = [];
    const doFoo = createRequest({
      method: "POST",
      path: "https://example.test/foo",
      body: Schema.Struct({ action: Schema.String }),
      defaultBody: { action: "foo" },
      responses: [response({ key: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })] as const,
    });
    const layer = fetchLayer(
      mockFetch(async (request) => {
        bodies.push(await request.json());
        return new Response(null, { status: 204 });
      }),
    );

    await doFoo().effect.pipe(Effect.provide(layer), Effect.runPromise);
    await doFoo().setBody({ action: "bar" }).effect.pipe(Effect.provide(layer), Effect.runPromise);

    expect(bodies).toEqual([{ action: "foo" }, { action: "bar" }]);
  });

  it("allows cache and retry defaults to be overridden at a call site", async () => {
    let attempts = 0;
    const getUsers = createApi("https://example.test", {
      cache: { control: "max-age=3600", fetch: "force-cache" },
      retries: 0,
    }).createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))] as const,
    });

    const result = await getUsers()
      .setCache({ control: "no-cache", fetch: "reload" })
      .setRetries(2)
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              attempts += 1;
              expect(request.cache).toBe("reload");
              expect(request.credentials).toBe("include");
              expect(request.mode).toBe("cors");
              expect(request.headers.get("cache-control")).toBe("no-cache");
              if (attempts < 3) throw new Error("temporary network failure");
              return Response.json([{ id: 1, name: "Ada" }]);
            }),
          ),
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include", mode: "cors" }),
        Effect.runPromise,
      );

    expect(attempts).toBe(3);
    expect(result.body).toEqual([{ id: 1, name: "Ada" }]);
  });

  it("preserves explicit Cache-Control headers regardless of cache setter order", async () => {
    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))] as const,
    });
    const requests: Array<Request> = [];
    const layer = fetchLayer(
      mockFetch(async (request) => {
        requests.push(request);
        return Response.json([]);
      }),
    );

    await getUsers()
      .setHeader("cache-control", "no-store")
      .setCache({ control: "max-age=60" })
      .effect.pipe(Effect.provide(layer), Effect.runPromise);
    await getUsers()
      .setCache({ control: "max-age=60" })
      .setHeader("cache-control", "no-store")
      .effect.pipe(Effect.provide(layer), Effect.runPromise);

    expect(requests.map((request) => request.headers.get("cache-control"))).toEqual(["no-store", "no-store"]);
  });

  it("fails with the untouched response when no rule matches", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ key: "ok", status: 200 }, User)] as const,
    });

    const result = await getUser().effect.pipe(
      Effect.either,
      Effect.provide(fetchLayer(mockFetch(async () => new Response("later", { status: 503 })))),
      Effect.runPromise,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(UnhandledResponse);
    }
    if (Either.isLeft(result) && result.left instanceof UnhandledResponse) {
      expect(result.left.response.status).toBe(503);
      expect(await Effect.runPromise(result.left.response.text)).toBe("later");
    }
  });
});
