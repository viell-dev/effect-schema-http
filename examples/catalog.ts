import { Config, Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "@effect/platform";
import { Body, Operation, Request, Response } from "../src/main.js";

export const Item = Schema.Struct({ id: Schema.String, quantity: Schema.NumberFromString });

/** The application owns its service, configuration keys, and transport composition. */
export const make = Effect.gen(function* () {
  const baseUrl = yield* Config.string("CATALOG_URL");
  const client = yield* HttpClient.HttpClient;
  const request = Request.get("").pipe(
    Request.baseUrl(baseUrl),
    Request.path(Schema.String, (id, encode) => `/items/${encode(id)}`),
  );
  const get = Operation.make(
    request,
    Response.status(200, Response.tag("Found", Body.jsonSchema(Item))).pipe(
      Response.orElse(Response.status(404, Response.tag("Missing", Body.empty))),
    ),
  );
  return {
    get: (id: string) =>
      get
        .execute({ path: id })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.withSpan("Catalog.get")),
  };
});

export class Catalog extends Context.Tag("example/Catalog")<Catalog, Effect.Effect.Success<typeof make>>() {}
export const layer = Layer.effect(Catalog, make);

export const program = Effect.gen(function* () {
  const catalog = yield* Catalog;
  const result = yield* catalog.get("item/42");
  return result._tag === "Found" ? result.value.quantity : 0;
});
