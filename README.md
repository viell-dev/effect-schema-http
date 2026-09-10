# Effect Schema HTTP

Lazy, schema-driven HTTP request plans built on Effect.

```sh
pnpm add viell-effect-schema-http effect @effect/platform
```

```ts
import { FetchHttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { createApi, makeRequestGate, response, setUrlParam, toEffect } from "viell-effect-schema-http";

const User = Schema.Struct({ id: Schema.String, name: Schema.String });

const api = createApi("https://api.example.com", {
  headers: { authorization: "Bearer token" },
});

const getUser = api.createRequest({
  method: "GET",
  path: "/users/:userId",
  responses: [response({ _tag: "ok", status: 200 }, User)],
});

const program = getUser({ userId: "user-1" }).pipe(
  setUrlParam("expand", "profile"),
  toEffect,
  Effect.provide(FetchHttpClient.layer),
);

const gatedProgram = Effect.gen(function* () {
  const users = yield* makeRequestGate((userId: string) => getUser({ userId }).effect, {
    key: (userId) => userId,
  });

  yield* users.run("user-1"); // sends
  yield* users.run("user-1"); // reuses the latest successful result
  yield* users.reload; // deliberately sends again
});
```

See [the design sketch](docs/design.md) for the proposed API, semantics, test strategy, and open questions.

## Tests

Unit and type-focused tests live beside the implementation under `src/`. Tests under `tests/` are integration tests
that use real ephemeral loopback HTTP servers with Fetch or purpose-built HTTP clients. The repeated-header integration
test uses a raw Node provider because Fetch is allowed to combine repeated field lines.

```sh
pnpm test:unit
pnpm test:integration
pnpm test
```
