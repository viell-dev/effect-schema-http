import { HttpClient, HttpClientResponse } from "@effect/platform";
import { ConfigProvider, Effect } from "effect";
import { expect, it } from "vitest";
import * as Catalog from "../../examples/catalog.js";
import * as Legacy from "../../examples/legacy.js";
import * as Search from "../../examples/search.js";

it("composes the documented application service with a config provider and transport", async () => {
  const client = HttpClient.make((request) => {
    expect(request.url).toBe("https://example.test/items/item%2F42");
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{"id":"item/42","quantity":"3"}')));
  });
  const result = await Effect.runPromise(
    Catalog.program.pipe(
      Effect.provide(Catalog.layer),
      Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["CATALOG_URL", "https://example.test"]]))),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  );
  expect(result).toBe(3);
});

it("round-trips the documented legacy format through its schema", async () => {
  const client = HttpClient.make((request) => {
    expect(request.headers["content-type"]).toBe("application/x-fixed-record");
    expect(request.body._tag).toBe("Uint8Array");
    if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded body");
    const body = new TextDecoder().decode(request.body.body);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { headers: { "content-type": "application/x-fixed-record" } }),
      ),
    );
  });
  expect(
    await Effect.runPromise(
      Legacy.exchange
        .execute({ body: { code: 42, label: "hello" } })
        .pipe(Effect.provideService(HttpClient.HttpClient, client)),
    ),
  ).toEqual({ code: 42, label: "hello" });
});

it("composes the documented interaction as a scoped application service", async () => {
  let calls = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      calls++;
      return HttpClientResponse.fromWeb(request, new Response('["one"]'));
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const search = yield* Search.Search;
      expect(yield* search.run("one")).toEqual(["one"]);
      expect(yield* search.run("one")).toEqual(["one"]);
    }).pipe(Effect.provide(Search.layer), Effect.provideService(HttpClient.HttpClient, client)),
  );
  expect(calls).toBe(1);
});
