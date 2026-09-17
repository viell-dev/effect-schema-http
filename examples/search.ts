import { Context, Layer, Schema } from "effect";
import { Body, Interaction, Operation, Request, Response } from "../src/main.js";

const search = Operation.make(
  Request.get("https://catalog.example.test/search").pipe(
    Request.query(Schema.Struct({ q: Schema.String })),
    Request.mapInput((input: string) => ({ query: { q: input } })),
  ),
  Response.status(200, Body.jsonSchema(Schema.Array(Schema.String))),
);

export class Search extends Context.Tag("example/Search")<
  Search,
  Interaction.Interaction<
    string,
    ReadonlyArray<string>,
    import("effect").Effect.Effect.Error<ReturnType<typeof search.execute>>
  >
>() {}

/** Give each independently owned interaction a fresh layer/runtime lifetime. */
export const layer = Layer.scoped(
  Search,
  Interaction.make(search.execute, {
    retain: (results) => results.length > 0,
  }),
);
