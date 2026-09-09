import { FetchHttpClient } from "@effect/platform";
import { Effect, Either, Layer, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createApi, createRequest, response, UnhandledResponse } from "./main.js";

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
  it("is lazy and replaces only the response rule with the same matcher", async () => {
    const requests: Array<Request> = [];
    const api = createApi("https://example.test", {
      headers: { authorization: "Bearer token" },
      responses: [response({ status: 404 }, NotFound)] as const,
    });
    const getUsers = api.createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ status: 200 }, Schema.Array(User))] as const,
    });

    const plan = getUsers().setUrlParam("fields", "id").setResponseSchema({ status: 200 }, Schema.Array(ThinUser));

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

  it("keeps mapped 4xx responses in the success channel", async () => {
    const api = createApi("https://example.test", {
      responses: [response({ status: 404 }, NotFound), response({ status: 410 }, Gone)] as const,
    });
    const getUser = api.createRequest({
      method: "GET",
      path: "/users/1",
      responses: [response({ status: 200 }, User)] as const,
    });

    const result = await getUser().effect.pipe(
      Effect.provide(fetchLayer(mockFetch(async () => Response.json({ deletedAt: "2026-09-09" }, { status: 410 })))),
      Effect.runPromise,
    );

    expect(result).toMatchObject({ status: 410, body: { deletedAt: "2026-09-09" } });
    if (result.status === 410) expectTypeOf(result.body).toEqualTypeOf<typeof Gone.Type>();

    const getDetailedUser = api.createRequest({
      method: "GET",
      path: "/detailed-users/1",
      responses: [response({ status: 404 }, DetailedNotFound)] as const,
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
      responses: [response({ status: 201 }, User)] as const,
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

  it("allows cache and retry defaults to be overridden at a call site", async () => {
    let attempts = 0;
    const getUsers = createApi("https://example.test", { cache: "force-cache", retries: 0 }).createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ status: 200 }, Schema.Array(User))] as const,
    });

    const result = await getUsers()
      .setCache("reload")
      .setRetries(2)
      .effect.pipe(
        Effect.provide(
          fetchLayer(
            mockFetch(async (request) => {
              attempts += 1;
              expect(request.cache).toBe("reload");
              if (attempts < 3) throw new Error("temporary network failure");
              return Response.json([{ id: 1, name: "Ada" }]);
            }),
          ),
        ),
        Effect.runPromise,
      );

    expect(attempts).toBe(3);
    expect(result.body).toEqual([{ id: 1, name: "Ada" }]);
  });

  it("fails with the untouched response when no rule matches", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response({ status: 200 }, User)] as const,
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
