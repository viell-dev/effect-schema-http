/**
 * The shared-schema model, driven end to end by the schemas themselves.
 *
 * Every other test in this repository checks one side: the domain package checks that a
 * schema decodes what it should, and `routes.test.ts` checks that a handler does what it
 * should when called directly. Neither exercises the thing this project is actually about
 * — that the *same* definition encodes on the server and decodes on the client, over a
 * real socket, for values nobody chose by hand.
 *
 * So this test boots the real HTTP server, declares the endpoints with the real client
 * library, and drives them with values generated from the schemas' own `arbitrary`
 * annotations. Four annotation kinds end up load-bearing at once:
 *
 * - `arbitrary` generates the inputs, using the constrained generators `primitives.ts`
 *   defines rather than rejection-sampling against a regex.
 * - The schema encodes the request and decodes the response, on both sides.
 * - `equivalence` — the custom one on `PostView`, which deliberately ignores timestamps
 *   and the revision counter — decides whether what came back is "the same post".
 * - `pretty` formats a failure, and is the reason a failing case is readable rather than
 *   a wall of branded strings.
 *
 * A property test over a network is unusual and worth the cost here for one reason: it is
 * the only way to find an encode/decode asymmetry that a hand-written fixture happens to
 * avoid. A `PostTitle` is `Schema.Trim`-based, for instance, so a generated title with
 * trailing whitespace is a different string after a round trip — which is correct, and is
 * exactly the kind of thing nobody writes a fixture for.
 */
import { createServer as createNodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Arbitrary, Effect, Equivalence, FastCheck, Pretty, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, response, toEffect } from "viell-effect-schema-http";
import {
  CreatePostInput,
  LoginInput,
  PostView,
  PostViewV2,
  RegisterInput,
  ACCEPT_VERSION_HEADER,
  SCHEMA_VERSION_HEADER,
  AuthResponse,
} from "@realworld/domain";
import { createHttpServer } from "@realworld/server";

let baseUrl = "";
let token = "";

const api = createApi("http://127.0.0.1:0", {
  headers: { authorization: () => (token === "" ? undefined : `Bearer ${token}`) },
});

const register = api.createRequest({
  method: "POST",
  path: "/api/users",
  body: RegisterInput,
  responses: [response({ _tag: "created", status: 201 }, AuthResponse)],
});

const login = api.createRequest({
  method: "POST",
  path: "/api/users/login",
  body: LoginInput,
  responses: [response({ _tag: "ok", status: 200 }, AuthResponse)],
});

const createPost = api.createRequest({
  method: "POST",
  path: "/api/posts",
  body: CreatePostInput,
  responses: [response({ _tag: "created", status: 201 }, PostView)],
});

const readPost = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug",
  responses: [response({ _tag: "ok", status: 200 }, PostView)],
});

const readPostVersioned = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug",
  headers: { [ACCEPT_VERSION_HEADER]: "2" },
  responses: [
    response({ _tag: "v2", status: 200, headers: { [SCHEMA_VERSION_HEADER]: "2" } }, PostViewV2),
    response({ _tag: "v1", status: 200, headers: { [SCHEMA_VERSION_HEADER]: "1" } }, PostView),
  ],
});

describe("the same schemas, over a real socket", () => {
  let server: ReturnType<typeof createHttpServer>;

  beforeAll(async () => {
    server = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const username = `prop${Date.now().toString(36)}`;
    const created = await Effect.runPromise(
      register()
        .setBaseUrl(baseUrl)
        .setBody({
          username: Schema.decodeUnknownSync(RegisterInput.fields.username)(username),
          email: Schema.decodeUnknownSync(RegisterInput.fields.email)(`${username}@example.com`),
          password: Schema.decodeUnknownSync(RegisterInput.fields.password)("propertytest1"),
          displayName: Schema.decodeUnknownSync(RegisterInput.fields.displayName)("Property Test"),
        })
        .pipe(toEffect, Effect.provide(FetchHttpClient.layer)),
    );
    token = created.body.token;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("round-trips every post the schemas can generate", async () => {
    const arbitraryInput = Arbitrary.make(CreatePostInput);
    const samePost = Equivalence.make(Schema.equivalence(PostView));
    const show = Pretty.make(PostView);
    let roundTrips = 0;

    await FastCheck.assert(
      FastCheck.asyncProperty(arbitraryInput, async (input) => {
        roundTrips += 1;
        const created = await Effect.runPromise(
          createPost().setBaseUrl(baseUrl).setBody(input).pipe(toEffect, Effect.provide(FetchHttpClient.layer)),
        );
        if (created._tag !== "created") throw new Error(`create answered ${created._tag}`);

        const read = await Effect.runPromise(
          readPost({ slug: created.body.slug })
            .setBaseUrl(baseUrl)
            .pipe(toEffect, Effect.provide(FetchHttpClient.layer)),
        );
        if (read._tag !== "ok") throw new Error(`read answered ${read._tag}`);

        // The custom equivalence: identity and content, ignoring the bookkeeping
        // timestamps and the revision counter that a write moves on.
        if (!samePost(created.body, read.body)) {
          throw new Error(`round trip changed the post:\n  wrote ${show(created.body)}\n  read  ${show(read.body)}`);
        }

        // The title survived as its *trimmed* form, because `PostTitle` is built on
        // `Schema.Trim`. The generated input may well have had surrounding whitespace,
        // and the stored value is the decoded one — which is the point of decoding at the
        // boundary rather than storing what arrived.
        expect(read.body.title).toBe(read.body.title.trim());
      }),
      // Fifty real HTTP round trips is enough to find an asymmetry and quick enough to
      // run on every commit.
      { numRuns: 50 },
    );

    // Proof the property actually ran rather than being silently skipped.
    expect(roundTrips).toBeGreaterThanOrEqual(50);
  }, 60_000);

  it("negotiates a schema version through a response rule", async () => {
    const created = await Effect.runPromise(
      createPost()
        .setBaseUrl(baseUrl)
        .setBody({
          title: Schema.decodeUnknownSync(CreatePostInput.fields.title)("A categorised post"),
          body: Schema.decodeUnknownSync(CreatePostInput.fields.body)("With a category."),
          visibility: "public",
          category: "engineering",
        })
        .pipe(toEffect, Effect.provide(FetchHttpClient.layer)),
    );
    if (created._tag !== "created") throw new Error(`create answered ${created._tag}`);

    // Asking for 2 gets 2, and the rule that matched proves the server agreed rather than
    // the client assuming.
    const modern = await Effect.runPromise(
      readPostVersioned({ slug: created.body.slug })
        .setBaseUrl(baseUrl)
        .pipe(toEffect, Effect.provide(FetchHttpClient.layer)),
    );
    expect(modern._tag).toBe("v2");
    if (modern._tag === "v2") expect(modern.body.category).toBe("engineering");

    // Not asking gets 1, and the older view simply does not carry the field — which is
    // what makes a browser tab opened before the deploy keep working.
    const legacy = await Effect.runPromise(
      readPost({ slug: created.body.slug }).setBaseUrl(baseUrl).pipe(toEffect, Effect.provide(FetchHttpClient.layer)),
    );
    expect(legacy._tag).toBe("ok");
    if (legacy._tag === "ok") expect(Object.hasOwn(legacy.body, "category")).toBe(false);

    // And an old server mid-rollout: asking for 2 and being answered 1 is a declared
    // response rather than an UnhandledResponse.
    const downgraded = await Effect.runPromise(
      readPostVersioned({ slug: created.body.slug })
        .setBaseUrl(baseUrl)
        .setHeader(ACCEPT_VERSION_HEADER, "1")
        .pipe(toEffect, Effect.provide(FetchHttpClient.layer)),
    );
    expect(downgraded._tag).toBe("v1");
  }, 20_000);
});
