# Effect Schema HTTP

Lazy, schema-driven HTTP request plans built on Effect.

```sh
pnpm add viell-effect-schema-http effect @effect/platform
```

```ts
import { FetchHttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { createApi, response } from "viell-effect-schema-http";

const User = Schema.Struct({ id: Schema.String, name: Schema.String });

const api = createApi("https://api.example.com", {
  headers: { authorization: "Bearer token" },
});

const getUser = api.createRequest({
  method: "GET",
  path: "/users/:userId",
  responses: [response({ key: "ok", status: 200 }, User)],
});

const program = getUser("user-1").effect.pipe(Effect.provide(FetchHttpClient.layer));
```

See [the design sketch](docs/design.md) for the proposed API, semantics, test strategy, and open questions.
