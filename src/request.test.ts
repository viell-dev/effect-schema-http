import { FetchHttpClient } from "@effect/platform";
import { Effect, Either, Layer, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createApi, createRequest, response, UnhandledResponse } from "./main.js";

const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
const ThinUser = Schema.Struct({ id: Schema.Number });
const NotFound = Schema.Struct({ message: Schema.String });

const fetchLayer = (handler: typeof fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, handler)));

const mockFetch = (handler: (request: Request) => Promise<Response>): typeof fetch =>
  ((input: URL | RequestInfo, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(input, init))) as typeof fetch;

describe("createRequest", () => {
  it("is lazy and lets a more specific response rule override the default status rule", async () => {
    const requests: Array<Request> = [];
    const getUsers = createApi("https://example.test", { headers: { authorization: "Bearer token" } }).createRequest({
      method: "GET",
      path: "/users",
      responses: [response.success({ status: 200 }, Schema.Array(User))] as const,
    });

    const plan = getUsers()
      .setUrlParam("fields", "id")
      .addResponseSchema(
        response.success({ status: 200, headers: { "x-response-shape": "thin" } }, Schema.Array(ThinUser)),
      );

    expect(requests).toEqual([]);

    const result = await plan.effect.pipe(
      Effect.provide(
        fetchLayer(
          mockFetch(async (request) => {
            requests.push(request);
            return new Response(JSON.stringify([{ id: 1 }]), {
              status: 200,
              headers: { "content-type": "application/json", "x-response-shape": "thin" },
            });
          }),
        ),
      ),
      Effect.runPromise,
    );

    expect(result).toEqual([{ id: 1 }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.test/users?fields=id");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token");
    expectTypeOf(result).toEqualTypeOf<ReadonlyArray<typeof User.Type> | ReadonlyArray<typeof ThinUser.Type>>();
  });

  it("encodes a typed request body before sending it", async () => {
    const createUser = createRequest({
      method: "POST",
      path: "https://example.test/users",
      body: Schema.Struct({ name: Schema.String }),
      responses: [response.success({ status: 201 }, User)] as const,
    });

    const result = await createUser({ name: "Ada" }).effect.pipe(
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

    expect(result.name).toBe("Ada");
  });

  it("routes mapped failures through the Effect error channel", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/404",
      responses: [response.success({ status: 200 }, User), response.failure({ status: 404 }, NotFound)] as const,
    });

    const result = await getUser().effect.pipe(
      Effect.either,
      Effect.provide(fetchLayer(mockFetch(async () => Response.json({ message: "missing" }, { status: 404 })))),
      Effect.runPromise,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toEqual({ message: "missing" });
  });

  it("fails with UnhandledResponse when no rule matches", async () => {
    const getUser = createRequest({
      method: "GET",
      path: "https://example.test/users/1",
      responses: [response.success({ status: 200 }, User)] as const,
    });

    const result = await getUser().effect.pipe(
      Effect.either,
      Effect.provide(fetchLayer(mockFetch(async () => new Response(null, { status: 204 })))),
      Effect.runPromise,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(UnhandledResponse);
  });
});
