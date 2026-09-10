import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Cause, Clock, Duration, Effect, Either, Layer, Match, ParseResult, Schedule, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AbsolutePathWithBaseUrl,
  createApi,
  createRequest,
  DuplicateResponseTag,
  extendApi,
  InvalidPathArguments,
  InvalidPathParameterValue,
  InvalidRetryCount,
  RequestBody,
  RequestBodyEncodeError,
  RequestBodyNotAllowed,
  RequestBodyRequired,
  response,
  ResponseBody,
  ResponseDecodeError,
  mapEndpoint,
  setBody as withBody,
  setHeader as withHeader,
  setResponseSchema as withResponseSchema,
  setUrlParam as withUrlParam,
  type Endpoint,
  type ResponseOf,
  type ResponseBodyCodec,
  toEffect,
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
  it("composes pipeable endpoints and plans without changing their lazy semantics", async () => {
    const requests: Array<Request> = [];
    const createUser = createRequest({
      method: "POST",
      path: "https://example.test/users",
      body: Schema.Struct({ name: Schema.String }),
      responses: [response({ _tag: "created", status: 201 }, User)],
    });
    const createAda = createUser.pipe(mapEndpoint(withBody({ name: "Ada" })));
    const effect = createAda().pipe(withHeader("x-source", "composed"), toEffect);

    expect(requests).toEqual([]);

    const result = await effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            requests.push(request);
            expect(request.headers.get("x-source")).toBe("composed");
            expect(await request.json()).toEqual({ name: "Ada" });
            return Response.json({ id: 1, name: "Ada" }, { status: 201 });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result.body.name).toBe("Ada");
    expect(requests).toHaveLength(1);

    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/teams/:teamId/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });
    const getThinUsers = getUsers.pipe(
      mapEndpoint((plan) =>
        plan.pipe(
          withUrlParam("fields", "id"),
          withResponseSchema({ _tag: "ok", status: 200 }, Schema.Array(ThinUser)),
        ),
      ),
    );

    expectTypeOf(getThinUsers).parameters.toEqualTypeOf<[parameters: { readonly teamId: string }]>();
    const thinPlan = getThinUsers({ teamId: "team-1" });
    type ThinResult = Effect.Effect.Success<typeof thinPlan.effect>;
    expectTypeOf<ThinResult["body"]>().toEqualTypeOf<ReadonlyArray<typeof ThinUser.Type>>();
  });

  it("constructs a fresh Effect only when a plan effect is read", () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ _tag: "ok", status: 200 }, User)],
    });
    const plan = getUser().setHeader("x-source", "test").setUrlParam("view", "full");
    const descriptor = Object.getOwnPropertyDescriptor(plan, "effect");

    expect(descriptor?.get).toBeTypeOf("function");
    expect(descriptor?.value).toBeUndefined();
    expect(plan.effect).not.toBe(plan.effect);
  });

  it("infers, validates, and encodes placeholders anywhere in a path", async () => {
    const getFile = createRequest({
      method: "GET",
      path: "https://example.test/v:version/files/:name.:ext",
      responses: [response({ _tag: "post", status: 200 }, Schema.Struct({ id: Schema.String }))] as const,
    });

    expectTypeOf(getFile).parameters.toEqualTypeOf<
      [
        parameters: {
          readonly version: string;
          readonly name: string;
          readonly ext: string;
        },
      ]
    >();
    const rejectInvalidPathTypes = () => {
      // @ts-expect-error -- path arguments are one named object, not positional values.
      getFile("2", "report", "json");
      // @ts-expect-error -- every placeholder is required.
      getFile({ version: "2", name: "report" });
      // @ts-expect-error -- undeclared path parameters are rejected.
      getFile({ version: "2", name: "report", ext: "json", extra: "value" });
    };
    void rejectInvalidPathTypes;

    const result = await getFile({ version: "2", name: "reports/annual", ext: "json" }).effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(request.url).toBe("https://example.test/v2/files/reports%2Fannual.json");
            return Response.json({ id: "reports/annual" });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result.body.id).toBe("reports/annual");

    const untypedGetFile = getFile as (...arguments_: Array<unknown>) => ReturnType<typeof getFile>;
    expect(() => untypedGetFile("2", "report", "json")).toThrow(InvalidPathArguments);
    expect(() => untypedGetFile({ version: "2", name: "report" })).toThrow(InvalidPathArguments);
    expect(() => untypedGetFile({ version: "2", name: "report", ext: "json", extra: "value" })).toThrow(
      InvalidPathArguments,
    );
    expect(() => untypedGetFile({ version: "2", name: "", ext: "json" })).toThrow(InvalidPathParameterValue);

    const inheritedParameters = Object.assign(Object.create({ version: "2" }) as object, {
      name: "report",
      ext: "json",
    });
    expect(() => untypedGetFile(inheritedParameters)).toThrow(InvalidPathArguments);

    const archiveUser = createRequest({
      method: "POST",
      path: "https://example.test/v1/users/:userId\\:archive",
      responses: [response({ _tag: "archived", status: 200 }, User)],
    });
    expectTypeOf(archiveUser).parameters.toEqualTypeOf<[parameters: { readonly userId: string }]>();

    await archiveUser({ userId: "user-1" }).effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(request.url).toBe("https://example.test/v1/users/user-1:archive");
            return Response.json({ id: 1, name: "Ada" });
          }),
        ),
      ),
      Effect.runPromise,
    );

    const literalVersion = createRequest({
      method: "GET",
      path: "https://example.test/v:1/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Void, { codec: ResponseBody.none })],
    });
    expectTypeOf(literalVersion).parameters.toEqualTypeOf<[]>();

    const repeatedParameter = createRequest({
      method: "GET",
      path: "https://example.test/:resource/mirrors/:resource",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Void, { codec: ResponseBody.none })],
    });
    expectTypeOf(repeatedParameter).parameters.toEqualTypeOf<[parameters: { readonly resource: string }]>();
    await repeatedParameter({ resource: "users" }).effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(request.url).toBe("https://example.test/users/mirrors/users");
            return new Response(undefined, { status: 200 });
          }),
        ),
      ),
      Effect.runPromise,
    );
  });

  it("merges plural URL parameter updates over API and endpoint defaults", async () => {
    const getUsers = createApi("https://example.test", {
      urlParams: { apiKey: "k", page: "1" },
    }).createRequest({
      method: "GET",
      path: "/users",
      urlParams: { locale: "sv" },
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))] as const,
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

  it("normalizes query parameters declared in the path before applying overrides", async () => {
    const getUsers = createApi("https://example.test/v1", {
      urlParams: { active: "api", locale: "sv" },
    }).createRequest({
      method: "GET",
      path: "/users?active=path&tag=a&tag=b#table",
      urlParams: { locale: "en" },
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });

    await getUsers()
      .setUrlParam("active", "plan")
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              const url = new URL(request.url);
              expect(url.pathname).toBe("/v1/users");
              expect(url.hash).toBe("#table");
              expect(url.searchParams.getAll("active")).toEqual(["plan"]);
              expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
              expect(url.searchParams.get("locale")).toBe("en");
              return Response.json([]);
            }),
          ),
        ),
        Effect.runPromise,
      );
  });

  it("rejects an absolute endpoint path when a base URL is configured", async () => {
    let sent = false;
    const getUsers = createApi("https://api.example.test").createRequest({
      method: "GET",
      path: "https://mirror.example.test/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });
    const result = await getUsers().effect.pipe(
      Effect.exit,
      Effect.provide(
        fetchLayer(
          mockFetch(async () => {
            sent = true;
            return Response.json([]);
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(sent).toBe(false);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBeInstanceOf(AbsolutePathWithBaseUrl);
  });

  it("supports repeated and targeted URL params and headers", async () => {
    const getUsers = createApi("https://example.test", {
      headers: { authorization: "Bearer token", "x-remove": "api", "x-repeat": ["a", "remove"] },
      urlParams: { remove: "api" },
    }).createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });

    await getUsers()
      .removeUrlParam("remove")
      .setUrlParam("bare", true)
      .setUrlParam("empty", "")
      .appendUrlParam("tag", "a")
      .appendUrlParam("tag", "b")
      .setHeaders({ "x-one": "1", "x-two": "2" })
      .removeHeader("x-remove")
      .appendHeader("x-repeat", "c")
      .removeHeader("x-repeat", "remove")
      .setHeader("x-repeat", "a", "updated")
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              const url = new URL(request.url);
              expect(request.url).toContain("bare&");
              expect(request.url).toContain("empty=");
              expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
              expect(url.searchParams.has("remove")).toBe(false);
              expect(request.headers.get("authorization")).toBe("Bearer token");
              expect(request.headers.get("x-one")).toBe("1");
              expect(request.headers.has("x-remove")).toBe(false);
              expect(request.headers.get("x-repeat")).toBe("updated, c");
              return Response.json([]);
            }),
          ),
        ),
        Effect.runPromise,
      );

    // @ts-expect-error Explicit false is the string "false"; only implicit true has special syntax.
    getUsers().setUrlParam("disabled", false);
  });

  it("composes API defaults, replaces an extended base URL, and permits a plan-level override", async () => {
    const notFound = response({ _tag: "not-found", status: 404 }, NotFound);
    const unauthorized = response({ _tag: "unauthorized", status: 401 }, Schema.Struct({ message: Schema.String }));
    const api = createApi("https://example.test/v1", {
      headers: { authorization: "Bearer base", "x-base": "1", "x-remove": "base" },
      urlParams: { scope: "base", page: "1", remove: "base" },
      responses: [notFound],
    });
    const adminApi = api.pipe(
      extendApi({
        baseUrl: "https://admin.example.test/v2",
        removeHeaders: ["authorization", "x-remove"],
        removeUrlParams: ["scope", "remove"],
        headers: { authorization: "Bearer admin" },
        urlParams: { scope: "admin" },
        responses: [unauthorized],
      }),
    );
    const getUsers = adminApi.createRequest({
      method: "GET",
      path: "/users",
      urlParams: { page: "2" },
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });

    expect(api.baseUrl).toBe("https://example.test/v1");
    expect(adminApi.baseUrl).toBe("https://admin.example.test/v2");

    let requestNumber = 0;
    const [result] = await Effect.all([
      getUsers().effect,
      getUsers().setBaseUrl("https://mirror.example.test").effect,
    ]).pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            const url = new URL(request.url);
            expect(url.origin).toBe(requestNumber === 0 ? "https://admin.example.test" : "https://mirror.example.test");
            expect(url.pathname).toBe(requestNumber === 0 ? "/v2/users" : "/users");
            expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "admin", page: "2" });
            expect(request.headers.get("authorization")).toBe("Bearer admin");
            expect(request.headers.get("x-base")).toBe("1");
            expect(request.headers.has("x-remove")).toBe(false);
            expect(url.searchParams.has("remove")).toBe(false);
            requestNumber += 1;
            return Response.json([]);
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result._tag).toBe("ok");
    type Result = Awaited<typeof result>;
    expectTypeOf<Result["_tag"]>().toEqualTypeOf<"ok" | "unauthorized" | "not-found">();
  });

  it("removes inherited headers and URL params from an endpoint definition", async () => {
    const getPublicUsers = createApi("https://example.test", {
      headers: { authorization: "Bearer token", "x-keep": "api", "x-values": ["keep", "remove"] },
      urlParams: { apiKey: "secret", locale: "sv", tag: ["keep", "remove"] },
    }).createRequest({
      method: "GET",
      path: "/users",
      removeHeaders: ["authorization", { name: "x-values", value: "remove" }],
      removeUrlParams: ["apiKey", { name: "tag", value: "remove" }],
      headers: { "x-endpoint": "public" },
      urlParams: { locale: "en" },
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });

    await getPublicUsers().effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            const url = new URL(request.url);
            expect(Object.fromEntries(url.searchParams)).toEqual({ tag: "keep", locale: "en" });
            expect(request.headers.has("authorization")).toBe(false);
            expect(request.headers.get("x-keep")).toBe("api");
            expect(request.headers.get("x-endpoint")).toBe("public");
            expect(request.headers.get("x-values")).toBe("keep");
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
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))] as const,
    });

    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))] as const,
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

    createRequest({
      method: "get",
      path: "https://example.test/users",
      // @ts-expect-error Fetch does not support GET request bodies regardless of method casing.
      body: Schema.Struct({ probe: Schema.Boolean }),
    });
  });

  it("passes custom HTTP methods through to the transport", async () => {
    const inspectUsers = createRequest({
      method: "PROPFIND",
      path: "https://example.test/users",
      responses: [response({ _tag: "multi-status", status: 207 }, Schema.Literal("inspected"))],
    });

    const result = await inspectUsers().effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(request.method).toBe("PROPFIND");
            return Response.json("inspected", { status: 207 });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result).toMatchObject({ _tag: "multi-status", body: "inspected" });
  });

  it("is lazy and replaces only the response rule with the same matcher", async () => {
    const requests: Array<Request> = [];
    const api = createApi("https://example.test", {
      headers: { authorization: "Bearer token" },
      responses: [response({ _tag: "not-found", status: 404 }, NotFound)] as const,
    });
    const getUsers = api.createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))] as const,
    });

    const plan = getUsers()
      .setUrlParam("fields", "id")
      .setResponseSchema({ _tag: "ok", status: 200 }, Schema.Array(ThinUser));

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
    const defaultRule = response({ _tag: "default", status: 404 }, NotFound);
    const firstRule = response({ _tag: "first", status: 200 }, User);
    const secondRule = response({ _tag: "second", status: 201 }, User);
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

  it("exposes the complete success, error, and requirement types", () => {
    const ok = response({ _tag: "ok", status: 200 }, User);
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [ok],
    });

    expectTypeOf(getUser().effect).toEqualTypeOf<
      Effect.Effect<
        ResponseOf<readonly [typeof ok]>,
        | UnhandledResponse
        | RequestBodyNotAllowed
        | HttpClientError.HttpClientError
        | Cause.TimeoutException
        | ResponseDecodeError,
        HttpClient.HttpClient
      >
    >();

    const noRules = createRequest({ method: "GET", path: "https://example.test/ping" });
    expectTypeOf(noRules().effect).toEqualTypeOf<
      Effect.Effect<
        never,
        UnhandledResponse | RequestBodyNotAllowed | HttpClientError.HttpClientError | Cause.TimeoutException,
        HttpClient.HttpClient
      >
    >();
  });

  it("makes an incomplete body plan non-executable in types and at runtime", async () => {
    let sent = false;
    const createUser = createRequest({
      method: "POST",
      path: "https://example.test/users",
      body: Schema.Struct({ name: Schema.String }),
      responses: [response({ _tag: "created", status: 201 }, User)],
    });
    const incomplete = createUser();

    expectTypeOf(incomplete.effect).toEqualTypeOf<RequestBodyRequired>();
    // @ts-expect-error An incomplete plan is not an Effect until setBody supplies its body.
    const invalidEffect: Effect.Effect<unknown> = incomplete.effect;
    const degradedEffect = invalidEffect as Effect.Effect<unknown, RequestBodyRequired>;
    const result = await degradedEffect.pipe(
      Effect.either,
      Effect.provide(
        fetchLayer(
          mockFetch(async () => {
            sent = true;
            return Response.json({ id: 1, name: "Ada" }, { status: 201 });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(sent).toBe(false);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RequestBodyRequired);
  });

  it("rejects duplicate response tags in declarations", () => {
    const duplicateRules = [
      response({ _tag: "same", status: 200 }, User),
      response({ _tag: "same", status: 201 }, User),
    ] as const;

    expect(() =>
      createRequest({
        method: "GET",
        path: "https://example.test/users",
        // @ts-expect-error Response tags must be unique within one declaration.
        responses: duplicateRules,
      }),
    ).toThrow(DuplicateResponseTag);
  });

  it("matches status and headers with predicates without exposing a consumed raw response", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [
        response(
          {
            _tag: "json",
            status: (status) => status >= 200 && status < 300,
            headers: { "content-type": (value) => value?.startsWith("application/json") ?? false },
          },
          User,
        ),
        response({ _tag: "success", status: (status) => status >= 200 && status < 300 }, User),
      ],
    });

    const result = await getUser().effect.pipe(
      Effect.provide(
        fetchLayer(mockFetch(async () => Response.json({ id: 1, name: "Ada" }, { headers: { "x-extra": "kept" } }))),
      ),
      Effect.runPromise,
    );

    expect(result._tag).toBe("json");
    expect(result.matched._tag).toBe("json");
    expect(result.status).toBe(200);
    expect(result.headers["x-extra"]).toBe("kept");
    expect("response" in result).toBe(false);
    expect("key" in result).toBe(false);
  });

  it("ranks matched headers first and exact statuses second when response rules overlap", async () => {
    let shaped = false;
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [
        response(
          {
            _tag: "shaped-success",
            status: (status) => status >= 200 && status < 300,
            headers: { "x-response-shape": "detailed" },
          },
          User,
        ),
        response({ _tag: "success", status: (status) => status >= 200 && status < 300 }, User),
        response({ _tag: "ok", status: 200 }, User),
      ],
    });
    const layer = fetchLayer(
      mockFetch(async () =>
        Response.json({ id: 1, name: "Ada" }, { headers: shaped ? { "x-response-shape": "detailed" } : undefined }),
      ),
    );

    const plain = await getUser().effect.pipe(Effect.provide(layer), Effect.runPromise);
    shaped = true;
    const detailed = await getUser().effect.pipe(Effect.provide(layer), Effect.runPromise);

    expect(plain._tag).toBe("ok");
    expect(detailed._tag).toBe("shaped-success");
  });

  it("reflects exact matched header names in their canonical lowercase form", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ _tag: "thin", status: 200, headers: { "X-Response-Shape": "thin" } }, ThinUser)],
    });

    const result = await getUser().effect.pipe(
      Effect.provide(
        fetchLayer(mockFetch(async () => Response.json({ id: 1 }, { headers: { "x-response-shape": "thin" } }))),
      ),
      Effect.runPromise,
    );

    expectTypeOf(result.headers["x-response-shape"]).toEqualTypeOf<"thin">();
    expect(result.headers["x-response-shape"]).toBe("thin");
    expect(result.headers["X-Response-Shape"]).toBeUndefined();
  });

  it("retains Fetch Set-Cookie values through response cookie metadata", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ _tag: "ok", status: 200 }, User)],
    });
    const responseHeaders = new globalThis.Headers({ "content-type": "application/json" });
    responseHeaders.append("set-cookie", "session=one; Path=/");
    responseHeaders.append("set-cookie", "preference=compact; Path=/");

    const result = await getUser().effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async () => new Response(JSON.stringify({ id: 1, name: "Ada" }), { headers: responseHeaders })),
        ),
      ),
      Effect.runPromise,
    );

    expect(result.headerEntries.filter(([name]) => name === "set-cookie")).toHaveLength(2);
    expect(result.cookies.cookies.session?.value).toBe("one");
    expect(result.cookies.cookies.preference?.value).toBe("compact");
  });

  it("preserves tie order when replacing a rule and lets a new plan rule take precedence", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ _tag: "first", status: 200 }, User), response({ _tag: "second", status: 200 }, User)],
    });
    const layer = fetchLayer(mockFetch(async () => Response.json({ id: 1, name: "Ada" })));

    const declared = await getUser().effect.pipe(Effect.provide(layer), Effect.runPromise);
    const replaced = await getUser()
      .setResponseSchema({ _tag: "second", status: 200 }, ThinUser)
      .effect.pipe(Effect.provide(layer), Effect.runPromise);
    const inserted = await getUser()
      .setResponseSchema({ _tag: "plan", status: 200 }, User)
      .effect.pipe(Effect.provide(layer), Effect.runPromise);

    expect(declared._tag).toBe("first");
    expect(replaced._tag).toBe("first");
    expect(inserted._tag).toBe("plan");
  });

  it("decodes text and drains no-body responses before decoding undefined", async () => {
    const getStatus = createRequest({
      method: "GET",
      path: "https://example.test/status",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Literal("ready"), { codec: ResponseBody.text })],
    });
    const trigger = createRequest({
      method: "POST",
      path: "https://example.test/trigger",
      responses: [response({ _tag: "done", status: 202 }, Schema.Void, { codec: ResponseBody.none })],
    });
    const Acknowledgement = Schema.transform(Schema.Undefined, Schema.Literal("accepted"), {
      strict: true,
      decode: () => "accepted" as const,
      encode: () => undefined,
    });
    const acknowledge = createRequest({
      method: "POST",
      path: "https://example.test/acknowledge",
      responses: [response({ _tag: "accepted", status: 204 }, Acknowledgement, { codec: ResponseBody.none })],
    });

    const text = await getStatus().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => new Response("ready")))),
      Effect.runPromise,
    );
    const none = await trigger().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => new Response("discarded", { status: 202 })))),
      Effect.runPromise,
    );
    const acknowledged = await acknowledge().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => new Response(null, { status: 204 })))),
      Effect.runPromise,
    );

    expect(text.body).toBe("ready");
    expect(none.body).toBeUndefined();
    expect(acknowledged.body).toBe("accepted");

    response(
      { _tag: "invalid", status: 204 },
      User,
      // @ts-expect-error A no-body codec requires a schema whose output accepts undefined.
      { codec: ResponseBody.none },
    );

    const UndefinedFromString = Schema.transform(Schema.String, Schema.Undefined, {
      strict: true,
      decode: () => undefined,
      encode: () => "undefined",
    });
    response(
      { _tag: "invalid-transform", status: 204 },
      UndefinedFromString,
      // @ts-expect-error A no-body codec supplies undefined to the schema's encoded side, which is string here.
      { codec: ResponseBody.none },
    );
  });

  it("distinguishes a JSON null value from empty and malformed JSON bodies", async () => {
    const getNull = createRequest({
      method: "GET",
      path: "https://example.test/value",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Null)],
    });
    const decode = (body: string) =>
      getNull().effect.pipe(
        Effect.either,
        Effect.provide(fetchLayer(mockFetch(async () => new Response(body, { status: 200 })))),
        Effect.runPromise,
      );

    const jsonNull = await decode("null");
    const empty = await decode("");
    const whitespace = await decode(" \n\t");
    const malformed = await decode("nul");

    expect(Either.isRight(jsonNull)).toBe(true);
    if (Either.isRight(jsonNull)) expect(jsonNull.right.body).toBeNull();
    for (const result of [empty, whitespace]) {
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(HttpClientError.ResponseError);
        if (result.left instanceof HttpClientError.ResponseError) expect(result.left.reason).toBe("EmptyBody");
      }
    }
    expect(Either.isLeft(malformed)).toBe(true);
    if (Either.isLeft(malformed)) {
      expect(malformed.left).toBeInstanceOf(HttpClientError.ResponseError);
      if (malformed.left instanceof HttpClientError.ResponseError) expect(malformed.left.reason).toBe("Decode");
    }
  });

  it("inherits and overrides the response reader independently of response schemas", async () => {
    const api = createApi("https://example.test", { responseCodec: ResponseBody.text });
    const getTextParsedUser = api.createRequest({
      method: "GET",
      path: "/text-user",
      responses: [response({ _tag: "ok", status: 200 }, Schema.parseJson(User))],
    });
    const getJsonUser = api.createRequest({
      method: "GET",
      path: "/json-user",
      responseCodec: ResponseBody.json,
      responses: [response({ _tag: "ok", status: 200 }, User)],
    });
    const getNoBody = api.createRequest({
      method: "GET",
      path: "/empty",
      responses: [response({ _tag: "empty", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
    });

    const textParsed = await getTextParsedUser().effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(request.headers.get("accept")).toBe("text/*");
            return new Response('{"id":1,"name":"Ada"}');
          }),
        ),
      ),
      Effect.runPromise,
    );
    const json = await getJsonUser().effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            expect(request.headers.get("accept")).toBe("application/json");
            return Response.json({ id: 2, name: "Grace" });
          }),
        ),
      ),
      Effect.runPromise,
    );
    const planOverride = await getJsonUser()
      .setResponseCodec(ResponseBody.text)
      .setResponseSchema({ _tag: "ok", status: 200 }, Schema.parseJson(User))
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              expect(request.headers.get("accept")).toBe("text/*");
              return new Response('{"id":3,"name":"Lin"}');
            }),
          ),
        ),
        Effect.runPromise,
      );
    const empty = await getNoBody().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => new Response(null, { status: 204 })))),
      Effect.runPromise,
    );

    expect(textParsed.body).toEqual({ id: 1, name: "Ada" });
    expect(json.body).toEqual({ id: 2, name: "Grace" });
    expect(planOverride.body).toEqual({ id: 3, name: "Lin" });
    expect(empty.body).toBeUndefined();
  });

  it("derives Accept from custom response codecs while preserving explicit headers", async () => {
    const customJson = {
      name: "custom-json",
      decode: (rawResponse: HttpClientResponse.HttpClientResponse) => rawResponse.json,
    } satisfies ResponseBodyCodec<unknown>;
    const customVendorJson = {
      name: "custom-vendor-json",
      accept: "application/vnd.example+json",
      decode: (rawResponse: HttpClientResponse.HttpClientResponse) => rawResponse.json,
    } satisfies ResponseBodyCodec<unknown>;
    const getJson = createRequest({
      method: "GET",
      path: "https://example.test/json-user",
      responseCodec: customJson,
      responses: [response({ _tag: "ok", status: 200 }, User)],
    });
    const getVendorJson = createRequest({
      method: "GET",
      path: "https://example.test/vendor-json-user",
      responseCodec: customVendorJson,
      responses: [response({ _tag: "ok", status: 200 }, User)],
    });
    const run = (expectedAccept: string) =>
      fetchLayer(
        mockFetch(async (request) => {
          expect(request.headers.get("accept")).toBe(expectedAccept);
          return Response.json({ id: 1, name: "Ada" });
        }),
      );

    await getJson().effect.pipe(Effect.provide(run("application/json")), Effect.runPromise);
    await getVendorJson().effect.pipe(Effect.provide(run("application/vnd.example+json")), Effect.runPromise);
    await getVendorJson()
      .setHeader("accept", "application/json")
      .effect.pipe(Effect.provide(run("application/json")), Effect.runPromise);
  });

  it("keeps mapped 4xx responses in the success channel", async () => {
    const api = createApi("https://example.test", {
      responses: [
        response({ _tag: "not-found", status: 404 }, NotFound),
        response({ _tag: "gone", status: 410 }, Gone),
      ] as const,
    });
    const getUser = api.createRequest({
      method: "GET",
      path: "/users/1",
      responses: [response({ _tag: "ok", status: 200 }, User)] as const,
    });

    const result = await getUser().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => Response.json({ deletedAt: "2026-09-09" }, { status: 410 })))),
      Effect.runPromise,
    );

    expect(result).toMatchObject({ status: 410, body: { deletedAt: "2026-09-09" } });
    if (result.status === 410) expectTypeOf(result.body).toEqualTypeOf<typeof Gone.Type>();
    const description = Match.value(result).pipe(
      Match.tag("ok", ({ body }) => body.name),
      Match.tag("not-found", ({ body }) => body.message),
      Match.tag("gone", ({ body }) => body.deletedAt),
      Match.exhaustive,
    );
    expect(description).toBe("2026-09-09");

    const getDetailedUser = api.createRequest({
      method: "GET",
      path: "/detailed-users/1",
      responses: [response({ _tag: "not-found", status: 404 }, DetailedNotFound)] as const,
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
      responses: [response({ _tag: "created", status: 201 }, User)] as const,
    });

    const plan = createUser();
    expectTypeOf(plan.setBody).parameter(0).toEqualTypeOf<{ readonly name: string }>();
    expectTypeOf(plan.effect).toEqualTypeOf<RequestBodyRequired>();

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

  it("schema-encodes text request bodies with an explicit wire codec", async () => {
    const XmlCommand = Schema.transform(Schema.String, Schema.Struct({ action: Schema.String }), {
      strict: true,
      decode: (xml) => ({ action: xml.slice("<action>".length, -"</action>".length) }),
      encode: (_encoded, command) => `<action>${command.action}</action>`,
    });
    const trigger = createRequest({
      method: "POST",
      path: "https://example.test/actions",
      body: XmlCommand,
      bodyCodec: RequestBody.text("application/xml"),
      responses: [response({ _tag: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
    });
    const requests: Array<Request> = [];
    const layer = fetchLayer(
      mockFetch(async (request) => {
        requests.push(request);
        return new Response(null, { status: 204 });
      }),
    );

    await trigger().setBody({ action: "archive" }).effect.pipe(Effect.provide(layer), Effect.runPromise);
    await trigger()
      .setBody({ action: "restore" })
      .setRequestBodyCodec(RequestBody.text("text/plain"))
      .effect.pipe(Effect.provide(layer), Effect.runPromise);

    expect(requests[0]?.headers.get("content-type")).toBe("application/xml");
    expect(await requests[0]?.text()).toBe("<action>archive</action>");
    expect(requests[1]?.headers.get("content-type")).toBe("text/plain");
    expect(await requests[1]?.text()).toBe("<action>restore</action>");

    createRequest({
      method: "POST",
      path: "https://example.test/invalid",
      body: Schema.Struct({ action: Schema.String }),
      // @ts-expect-error The text codec requires a schema whose encoded representation is a string.
      bodyCodec: RequestBody.text(),
    });
  });

  it("wraps fallible request schema encoding with request context", async () => {
    const XmlString = Schema.String.pipe(Schema.filter((value) => /^<action>[^<]+<\/action>$/.test(value)));
    const trigger = createRequest({
      method: "POST",
      path: "https://example.test/actions",
      body: XmlString,
      bodyCodec: RequestBody.text("application/xml"),
      responses: [response({ _tag: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
    });
    let sent = false;

    const result = await trigger()
      .setBody("not xml")
      .effect.pipe(
        Effect.either,
        Effect.provide(
          fetchLayer(
            mockFetch(async () => {
              sent = true;
              return new Response(null, { status: 204 });
            }),
          ),
        ),
        Effect.runPromise,
      );

    expect(sent).toBe(false);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(RequestBodyEncodeError);
      if (result.left instanceof RequestBodyEncodeError) {
        expect(result.left.request.method).toBe("POST");
        expect(result.left.request.url).toBe("https://example.test/actions");
        expect(ParseResult.isParseError(result.left.cause)).toBe(true);
      }
    }
  });

  it("can execute with a schema-encoded static body and override it through the setter", async () => {
    const bodies: Array<unknown> = [];
    const doFoo = createRequest({
      method: "POST",
      path: "https://example.test/foo",
      body: Schema.Struct({ action: Schema.String }),
      defaultBody: { action: "foo" },
      responses: [response({ _tag: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })] as const,
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

  it("checks default bodies against the schema type with useful diagnostics", () => {
    const Body = Schema.Struct({ action: Schema.String });

    createRequest({
      method: "POST",
      path: "https://example.test/actions",
      body: Body,
      // @ts-expect-error Object literal may only specify schema properties.
      defaultBody: { action: "foo", unexpected: true },
    });
    createRequest({
      method: "POST",
      path: "https://example.test/actions",
      body: Body,
      // @ts-expect-error The default body's fields must match the schema type.
      defaultBody: { action: 1 },
    });
  });

  it("allows cache and retry defaults to be overridden at a call site", async () => {
    let attempts = 0;
    const getUsers = createApi("https://example.test", {
      cache: { control: "max-age=3600", fetch: "force-cache" },
      retries: 0,
    }).createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))] as const,
    });

    const result = await getUsers()
      .setCache({ control: "no-cache", fetch: "reload" })
      .setRetry({ times: 2, schedule: Schedule.recurs(2) })
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

  it("retries mapped transient responses, drains intermediates, and returns the final mapped value", async () => {
    const responses: Array<Response> = [];
    const getHealth = createRequest({
      method: "GET",
      path: "https://example.test/health",
      responses: [
        response({ _tag: "available", status: 200 }, Schema.Struct({ ready: Schema.Literal(true) })),
        response({ _tag: "unavailable", status: 503 }, Schema.Struct({ retryAfter: Schema.Number })),
      ],
    });

    const result = await getHealth()
      .setRetry({ times: 2, schedule: Schedule.recurs(2) })
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async () => {
              const raw = Response.json({ retryAfter: 1 }, { status: 503 });
              responses.push(raw);
              return raw;
            }),
          ),
        ),
        Effect.runPromise,
      );

    expect(responses).toHaveLength(3);
    expect(responses.map((raw) => raw.bodyUsed)).toEqual([true, true, true]);
    expect(result).toMatchObject({ _tag: "unavailable", body: { retryAfter: 1 } });
  });

  it("keeps the built-in transient response statuses aligned with Effect's HTTP client", async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      let attempts = 0;
      const getStatus = createRequest({
        method: "GET",
        path: "https://example.test/status",
        responses: [
          response({ _tag: `status-${status}`, status }, Schema.Void, {
            codec: ResponseBody.none,
          }),
        ],
      });

      await getStatus()
        .setRetry({ times: 1, schedule: Schedule.recurs(1) })
        .effect.pipe(
          Effect.provide(
            fetchLayer(
              mockFetch(async () => {
                attempts += 1;
                return new Response(undefined, { status });
              }),
            ),
          ),
          Effect.runPromise,
        );

      expect(attempts).toBe(2);
    }
  });

  it("shares one retry budget across alternating transport and response failures", async () => {
    let attempts = 0;
    const getHealth = createRequest({
      method: "GET",
      path: "https://example.test/health",
      responses: [response({ _tag: "unavailable", status: 503 }, Schema.Struct({ retryAfter: Schema.Number }))],
    });

    const result = await getHealth()
      .setRetry({ times: 2, schedule: Schedule.recurs(2) })
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async () => {
              attempts += 1;
              if (attempts % 2 === 1) throw new TypeError("transport failed");
              return Response.json({ retryAfter: 1 }, { status: 503 });
            }),
          ),
        ),
        Effect.either,
        Effect.runPromise,
      );

    expect(attempts).toBe(3);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("extends retry classification and treats Retry-After as a configurable minimum delay", async () => {
    const run = async (respectRetryAfter: boolean, retryAfter = "2") => {
      let attempts = 0;
      let now = 0;
      const sleeps: Array<number> = [];
      const bodyUsedAtSleep: Array<boolean> = [];
      const responses: Array<Response> = [];
      const clock: Clock.Clock = {
        [Clock.ClockTypeId]: Clock.ClockTypeId,
        unsafeCurrentTimeMillis: () => now,
        currentTimeMillis: Effect.sync(() => now),
        unsafeCurrentTimeNanos: () => BigInt(now) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
        sleep: (duration) =>
          Effect.sync(() => {
            const milliseconds = Duration.toMillis(duration);
            sleeps.push(milliseconds);
            bodyUsedAtSleep.push(responses[0]?.bodyUsed ?? false);
            now += milliseconds;
          }),
      };
      const updateUser = createRequest({
        method: "PATCH",
        path: "https://example.test/users/1",
        responses: [response({ _tag: "ok", status: 200 }, User), response({ _tag: "conflict", status: 409 }, User)],
      });

      const result = await updateUser()
        .setRetry({
          times: 1,
          schedule: Schedule.spaced("100 millis"),
          while: (input) => HttpClientResponse.TypeId in input && input.status === 409,
          respectRetryAfter,
        })
        .effect.pipe(
          Effect.provide(
            fetchLayer(
              mockFetch(async () => {
                attempts += 1;
                const rawResponse = Response.json(
                  { id: 1, name: "Ada" },
                  attempts === 1 ? { status: 409, headers: { "retry-after": retryAfter } } : { status: 200 },
                );
                responses.push(rawResponse);
                return rawResponse;
              }),
            ),
          ),
          Effect.withClock(clock),
          Effect.runPromise,
        );

      return { attempts, bodyUsedAtSleep, result, sleeps };
    };

    const respected = await run(true);
    const dated = await run(true, new Date(2_000).toUTCString());
    const ignored = await run(false);

    expect(respected).toMatchObject({ attempts: 2, bodyUsedAtSleep: [true], sleeps: [2_000] });
    expect(dated).toMatchObject({ attempts: 2, bodyUsedAtSleep: [true], sleeps: [2_000] });
    expect(ignored).toMatchObject({ attempts: 2, bodyUsedAtSleep: [true], sleeps: [100] });
    expect(respected.result._tag).toBe("ok");
    expect(dated.result._tag).toBe("ok");
    expect(ignored.result._tag).toBe("ok");
  });

  it("rejects invalid retry counts and applies plan-level client transforms", async () => {
    let transformed = false;
    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });

    expect(() => getUsers().setRetries(-1)).toThrow(InvalidRetryCount);
    expect(() => getUsers().setRetries(1.5)).toThrow(InvalidRetryCount);
    expect(() => getUsers().setRetries(Number.NaN)).toThrow(InvalidRetryCount);

    await getUsers()
      .mapClient((client) => {
        transformed = true;
        return client;
      })
      .effect.pipe(Effect.provide(fetchLayer(mockFetch(async () => Response.json([])))), Effect.runPromise);

    expect(transformed).toBe(true);
  });

  it("applies per-attempt timeouts and retries timeout failures", async () => {
    let attempts = 0;
    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });

    const result = await getUsers()
      .setTimeout("1 millis")
      .setRetry({ times: 1, schedule: Schedule.recurs(1) })
      .effect.pipe(
        Effect.either,
        Effect.provide(
          fetchLayer(
            mockFetch(async () => {
              attempts += 1;
              await new Promise((resolve) => setTimeout(resolve, 25));
              return Response.json([]);
            }),
          ),
        ),
        Effect.runPromise,
      );

    expect(attempts).toBe(2);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(Cause.isTimeoutException(result.left)).toBe(true);
  });

  it("includes response body decoding in the per-attempt timeout", async () => {
    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))],
    });
    const slowBody = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("[]"));
          controller.close();
        }, 50);
      },
    });

    const result = await getUsers()
      .setTimeout("5 millis")
      .effect.pipe(
        Effect.either,
        Effect.provide(
          fetchLayer(
            mockFetch(async () => new Response(slowBody, { headers: { "content-type": "application/json" } })),
          ),
        ),
        Effect.runPromise,
      );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(Cause.isTimeoutException(result.left)).toBe(true);
  });

  it("preserves explicit Cache-Control headers regardless of cache setter order", async () => {
    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Array(User))] as const,
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

  it("drains an unhandled response body by default", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ _tag: "ok", status: 200 }, User)] as const,
    });
    const source = new Response("later", { status: 503 });

    const result = await getUser().effect.pipe(
      Effect.either,
      Effect.provide(fetchLayer(mockFetch(async () => source))),
      Effect.runPromise,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(UnhandledResponse);
    }
    if (Either.isLeft(result) && result.left instanceof UnhandledResponse) {
      expect(result.left.response.status).toBe(503);
    }
    expect(source.bodyUsed).toBe(true);

    const emptyResult = await createRequest({ method: "GET", path: "https://example.test/no-content" })().effect.pipe(
      Effect.either,
      Effect.provide(fetchLayer(mockFetch(async () => new Response(null, { status: 204 })))),
      Effect.runPromise,
    );
    expect(Either.isLeft(emptyResult)).toBe(true);
    if (Either.isLeft(emptyResult) && emptyResult.left instanceof UnhandledResponse) {
      expect(emptyResult.left.status).toBe(204);
    }
  });

  it("can retain an unhandled response body for caller-owned recovery", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ _tag: "ok", status: 200 }, User)],
    });
    const source = new Response("later", { status: 503 });

    const result = await getUser()
      .setUnhandledResponseBody("retain")
      .effect.pipe(Effect.either, Effect.provide(fetchLayer(mockFetch(async () => source))), Effect.runPromise);

    expect(source.bodyUsed).toBe(false);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result) && result.left instanceof UnhandledResponse) {
      expect(await Effect.runPromise(result.left.response.text)).toBe("later");
    }

    const discardedSource = new Response("ignore me", { status: 503 });
    const discarded = await getUser()
      .setUnhandledResponseBody("retain")
      .effect.pipe(
        Effect.either,
        Effect.provide(fetchLayer(mockFetch(async () => discardedSource))),
        Effect.runPromise,
      );
    if (Either.isLeft(discarded) && discarded.left instanceof UnhandledResponse) {
      await Effect.runPromise(discarded.left.discard);
    }
    expect(discardedSource.bodyUsed).toBe(true);
  });

  it("wraps schema failures with response and rule context", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ _tag: "ok", status: 200 }, User)],
    });

    const result = await getUser().effect.pipe(
      Effect.either,
      Effect.provide(fetchLayer(mockFetch(async () => Response.json({ id: "wrong", name: "Ada" })))),
      Effect.runPromise,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ResponseDecodeError);
      if (result.left instanceof ResponseDecodeError) {
        expect(result.left.responseTag).toBe("ok");
        expect(result.left.status).toBe(200);
        expect(result.left.response.status).toBe(200);
      }
    }
  });
});
