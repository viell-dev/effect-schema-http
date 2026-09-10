import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "@effect/platform";
import { Cause, Effect, Either, Layer, Match, ParseResult, Schedule, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AbsolutePathWithBaseUrl,
  createApi,
  createRequest,
  DuplicateResponseKey,
  extendApi,
  InvalidPathArguments,
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
      responses: [response({ key: "created", status: 201 }, User)],
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
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
    });
    const getThinUsers = getUsers.pipe(
      mapEndpoint((plan) =>
        plan.pipe(withUrlParam("fields", "id"), withResponseSchema({ key: "ok", status: 200 }, Schema.Array(ThinUser))),
      ),
    );

    expectTypeOf(getThinUsers).parameters.toEqualTypeOf<[value: string]>();
    const thinPlan = getThinUsers("team-1");
    type ThinResult = Effect.Effect.Success<typeof thinPlan.effect>;
    expectTypeOf<ThinResult["body"]>().toEqualTypeOf<ReadonlyArray<typeof ThinUser.Type>>();
  });

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

    const archiveUser = createRequest({
      method: "POST",
      path: "https://example.test/v1/users/:userId\\:archive",
      responses: [response({ key: "archived", status: 200 }, User)],
    });
    expectTypeOf(archiveUser).parameters.toEqualTypeOf<[value: string]>();

    await archiveUser("user-1").effect.pipe(
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
      responses: [response({ key: "ok", status: 200 }, Schema.Void, { codec: ResponseBody.none })],
    });
    expectTypeOf(literalVersion).parameters.toEqualTypeOf<[]>();
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

  it("normalizes query parameters declared in the path before applying overrides", async () => {
    const getUsers = createApi("https://example.test/v1", {
      urlParams: { active: "api", locale: "sv" },
    }).createRequest({
      method: "GET",
      path: "/users?active=path&tag=a&tag=b#table",
      urlParams: { locale: "en" },
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
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
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
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

  it("supports repeated and removed URL params plus plural and removed headers", async () => {
    const getUsers = createApi("https://example.test", {
      headers: { authorization: "Bearer token", "x-remove": "api" },
      urlParams: { remove: "api" },
    }).createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
    });

    await getUsers()
      .removeUrlParam("remove")
      .appendUrlParam("tag", "a")
      .appendUrlParam("tag", "b")
      .setHeaders({ "x-one": "1", "x-two": "2" })
      .removeHeader("x-remove")
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              const url = new URL(request.url);
              expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
              expect(url.searchParams.has("remove")).toBe(false);
              expect(request.headers.get("authorization")).toBe("Bearer token");
              expect(request.headers.get("x-one")).toBe("1");
              expect(request.headers.has("x-remove")).toBe(false);
              return Response.json([]);
            }),
          ),
        ),
        Effect.runPromise,
      );
  });

  it("composes API defaults and permits a plan-level base URL override", async () => {
    const notFound = response({ key: "not-found", status: 404 }, NotFound);
    const unauthorized = response({ key: "unauthorized", status: 401 }, Schema.Struct({ message: Schema.String }));
    const api = createApi("https://example.test", {
      headers: { authorization: "Bearer base", "x-base": "1" },
      urlParams: { scope: "base", page: "1" },
      responses: [notFound],
    });
    const adminApi = api.pipe(
      extendApi({
        headers: { authorization: "Bearer admin" },
        urlParams: { scope: "admin" },
        responses: [unauthorized],
      }),
    );
    const getUsers = adminApi.createRequest({
      method: "GET",
      path: "/users",
      urlParams: { page: "2" },
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
    });

    expect(api.baseUrl).toBe("https://example.test");
    expect(adminApi.baseUrl).toBe("https://example.test");

    const result = await getUsers()
      .setBaseUrl("https://mirror.example.test")
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              const url = new URL(request.url);
              expect(url.origin).toBe("https://mirror.example.test");
              expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "admin", page: "2" });
              expect(request.headers.get("authorization")).toBe("Bearer admin");
              expect(request.headers.get("x-base")).toBe("1");
              return Response.json([]);
            }),
          ),
        ),
        Effect.runPromise,
      );

    expect(result.key).toBe("ok");
    type Result = Awaited<typeof result>;
    expectTypeOf<Result["key"]>().toEqualTypeOf<"ok" | "unauthorized" | "not-found">();
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
      responses: [response({ key: "multi-status", status: 207 }, Schema.Literal("inspected"))],
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

    expect(result).toMatchObject({ key: "multi-status", body: "inspected" });
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

  it("exposes the complete success, error, and requirement types", () => {
    const ok = response({ key: "ok", status: 200 }, User);
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
      responses: [response({ key: "created", status: 201 }, User)],
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

  it("matches status and headers with predicates without exposing a consumed raw response", async () => {
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
    expect(result.headers["x-extra"]).toBe("kept");
    expect("response" in result).toBe(false);
  });

  it("reflects exact matched header names in their canonical lowercase form", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ key: "thin", status: 200, headers: { "X-Response-Shape": "thin" } }, ThinUser)],
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

  it("preserves tie order when replacing a rule and lets a new plan rule take precedence", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ key: "first", status: 200 }, User), response({ key: "second", status: 200 }, User)],
    });
    const layer = fetchLayer(mockFetch(async () => Response.json({ id: 1, name: "Ada" })));

    const declared = await getUser().effect.pipe(Effect.provide(layer), Effect.runPromise);
    const replaced = await getUser()
      .setResponseSchema({ key: "second", status: 200 }, ThinUser)
      .effect.pipe(Effect.provide(layer), Effect.runPromise);
    const inserted = await getUser()
      .setResponseSchema({ key: "plan", status: 200 }, User)
      .effect.pipe(Effect.provide(layer), Effect.runPromise);

    expect(declared.key).toBe("first");
    expect(replaced.key).toBe("first");
    expect(inserted.key).toBe("plan");
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
    const Acknowledgement = Schema.transform(Schema.Undefined, Schema.Literal("accepted"), {
      strict: true,
      decode: () => "accepted" as const,
      encode: () => undefined,
    });
    const acknowledge = createRequest({
      method: "POST",
      path: "https://example.test/acknowledge",
      responses: [response({ key: "accepted", status: 204 }, Acknowledgement, { codec: ResponseBody.none })],
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
      { key: "invalid", status: 204 },
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
      { key: "invalid-transform", status: 204 },
      UndefinedFromString,
      // @ts-expect-error A no-body codec supplies undefined to the schema's encoded side, which is string here.
      { codec: ResponseBody.none },
    );
  });

  it("inherits and overrides the response reader independently of response schemas", async () => {
    const api = createApi("https://example.test", { responseCodec: ResponseBody.text });
    const getTextParsedUser = api.createRequest({
      method: "GET",
      path: "/text-user",
      responses: [response({ key: "ok", status: 200 }, Schema.parseJson(User))],
    });
    const getJsonUser = api.createRequest({
      method: "GET",
      path: "/json-user",
      responseCodec: ResponseBody.json,
      responses: [response({ key: "ok", status: 200 }, User)],
    });
    const getNoBody = api.createRequest({
      method: "GET",
      path: "/empty",
      responses: [response({ key: "empty", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
    });

    const textParsed = await getTextParsedUser().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => new Response('{"id":1,"name":"Ada"}')))),
      Effect.runPromise,
    );
    const json = await getJsonUser().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => Response.json({ id: 2, name: "Grace" })))),
      Effect.runPromise,
    );
    const planOverride = await getJsonUser()
      .setResponseCodec(ResponseBody.text)
      .setResponseSchema({ key: "ok", status: 200 }, Schema.parseJson(User))
      .effect.pipe(
        Effect.provide(fetchLayer(mockFetch(async () => new Response('{"id":3,"name":"Lin"}')))),
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
      responses: [response({ key: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
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
      responses: [response({ key: "done", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
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
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))] as const,
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
        response({ key: "available", status: 200 }, Schema.Struct({ ready: Schema.Literal(true) })),
        response({ key: "unavailable", status: 503 }, Schema.Struct({ retryAfter: Schema.Number })),
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
    expect(result).toMatchObject({ key: "unavailable", body: { retryAfter: 1 } });
  });

  it("shares one retry budget across alternating transport and response failures", async () => {
    let attempts = 0;
    const getHealth = createRequest({
      method: "GET",
      path: "https://example.test/health",
      responses: [response({ key: "unavailable", status: 503 }, Schema.Struct({ retryAfter: Schema.Number }))],
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

  it("rejects invalid retry counts and applies plan-level client transforms", async () => {
    let transformed = false;
    const getUsers = createRequest({
      method: "GET",
      path: "https://example.test/users",
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
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
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
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
      responses: [response({ key: "ok", status: 200 }, Schema.Array(User))],
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

  it("wraps schema failures with response and rule context", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ key: "ok", status: 200 }, User)],
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
        expect(result.left.key).toBe("ok");
        expect(result.left.status).toBe(200);
        expect(result.left.response.status).toBe(200);
      }
    }
  });
});
