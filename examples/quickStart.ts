/** Typechecked version of the README quick-start example. */
import { FetchHttpClient } from "@effect/platform";
import { Effect, Match, Schema } from "effect";
import { createApi, response, setUrlParam, toEffect } from "../src/main.js";

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const NotFound = Schema.Struct({
  resource: Schema.String,
  id: Schema.String,
});

const api = createApi("https://api.example.com", {
  headers: { authorization: "Bearer token" },
  responses: [response({ _tag: "not-found", status: 404 }, NotFound)],
});

const getUser = api.createRequest({
  method: "GET",
  path: "/users/:userId",
  responses: [response({ _tag: "ok", status: 200 }, User)],
});

/** Example program requiring only the selected HTTP provider. */
export const program = Effect.gen(function* () {
  const result = yield* getUser({ userId: "user-1" }).pipe(setUrlParam("expand", "profile"), toEffect);

  return Match.value(result).pipe(
    Match.tag("ok", ({ body }) => body.name),
    Match.tag("not-found", ({ body }) => `${body.resource} ${body.id} was not found`),
    Match.exhaustive,
  );
}).pipe(Effect.provide(FetchHttpClient.layer));
