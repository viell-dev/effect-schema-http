import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { createCatalogClient } from "./createCatalogClient.js";

const id = "123e4567-e89b-42d3-a456-426614174000";
const catalog = createCatalogClient("https://example.test");
const clientFor = (respond: () => Response) =>
  HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, respond())));

describe("catalog metadata recipe", () => {
  it("keeps construction lazy and validates query encoding and page metadata", async () => {
    let calls = 0;
    const operation = catalog.list({ offset: 2, limit: 10 });
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++;
        expect(request.url).toBe("https://example.test/catalog?offset=2&limit=10");
        return HttpClientResponse.fromWeb(
          request,
          Response.json([{ id, name: "Ada" }], { headers: { "x-total-count": "17" } }),
        );
      }),
    );
    expect(calls).toBe(0);
    const page = await Effect.runPromise(operation.pipe(Effect.provideService(HttpClient.HttpClient, client)));
    expect(page.items).toEqual([{ id, name: "Ada" }]);
    expect(page.totalCount).toBe(17);
    expect(page.response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("maps an explicit 204 to an empty page and still validates its count", async () => {
    const page = await Effect.runPromise(
      catalog.list({ offset: 0, limit: 10 }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor(() => new Response(null, { status: 204, headers: { "x-total-count": "0" } })),
        ),
      ),
    );
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.response._tag).toBe("empty");
  });

  it.each([undefined, "", "12garbage", "-1", "1.5", "9007199254740992"])(
    "rejects malformed count %s with response context",
    async (count) => {
      const result = await Effect.runPromise(
        catalog.list({ offset: 0, limit: 10 }).pipe(
          Effect.either,
          Effect.provideService(
            HttpClient.HttpClient,
            clientFor(() => Response.json([], { headers: count === undefined ? {} : { "x-total-count": count } })),
          ),
        ),
      );
      expect(Either.isLeft(result) && result.left._tag).toBe("InvalidPageMetadata");
      if (Either.isLeft(result) && result.left._tag === "InvalidPageMetadata") {
        expect(result.left.status).toBe(200);
        expect(result.left.headers["x-total-count"]).toBe(count);
        expect(result.left.cause._tag).toBe("ParseError");
      }
    },
  );

  it("uses a valid Location and drains a non-JSON body to completion", async () => {
    let drained = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("not JSON"));
        },
        pull(controller) {
          drained = true;
          controller.close();
        },
      }),
      { status: 201, headers: { location: `/catalog/${id}?view=full#created` } },
    );
    const result = await Effect.runPromise(
      catalog.create({ name: "Ada" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor(() => response),
        ),
      ),
    );
    expect(result.body).toEqual({ id });
    expect(response.bodyUsed).toBe(true);
    expect(drained).toBe(true);
  });

  it.each([undefined, "/catalog/not-a-uuid"])(
    "falls back from Location %s to a validated JSON body",
    async (location) => {
      const response = Response.json({ id }, { status: 201, headers: location === undefined ? {} : { location } });
      const result = await Effect.runPromise(
        catalog.create({ name: "Ada" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            clientFor(() => response),
          ),
        ),
      );
      expect(result.body).toEqual({ id });
      expect(response.bodyUsed).toBe(true);
    },
  );

  it("rejects an invalid fallback id as a response-schema error", async () => {
    const result = await Effect.runPromise(
      catalog.create({ name: "Ada" }).pipe(
        Effect.either,
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor(() => Response.json({ id: "bad" }, { status: 201 })),
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("ResponseDecodeError");
  });
});
