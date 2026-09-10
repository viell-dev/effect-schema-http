import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as routes from "./routes.js";
import { Store } from "./store.js";
import type { JsonResponse } from "./httpError.js";

const run = <E>(effect: Effect.Effect<JsonResponse, E, Store>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Store.Default)) as Effect.Effect<JsonResponse, E>);

const registerAda = () =>
  run(
    routes.register({
      username: "ada",
      email: "ada@example.com",
      password: "lovelace1",
      displayName: "Ada Lovelace",
    }),
  );

describe("auth", () => {
  it("registers a new user and returns a token + profile", async () => {
    const response = await registerAda();
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ profile: { username: "ada" } });
  });

  it("rejects a duplicate username with 409", async () => {
    const program = Effect.gen(function* () {
      const first = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada",
      });
      const second = yield* routes.register({
        username: "ada",
        email: "other@example.com",
        password: "somethingelse1",
        displayName: "Impostor",
      });
      return { first, second };
    }).pipe(Effect.provide(Store.Default));
    const { first, second } = await Effect.runPromise(
      program as Effect.Effect<{ first: JsonResponse; second: JsonResponse }>,
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  it("rejects an invalid registration payload with 400", async () => {
    const response = await run(routes.register({ username: "a", email: "not-an-email", password: "short" }));
    expect(response.status).toBe(400);
    expect((response.body as { issues: ReadonlyArray<string> }).issues.length).toBeGreaterThan(0);
  });

  it("rejects login with the wrong password using 401", async () => {
    const layer = Store.Default;
    const program = Effect.gen(function* () {
      yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada",
      });
      return yield* routes.login({ email: "ada@example.com", password: "wrong-password" });
    }).pipe(Effect.provide(layer));
    const response = await Effect.runPromise(program as Effect.Effect<JsonResponse>);
    expect(response.status).toBe(401);
  });
});

describe("posts and visibility", () => {
  const scenario = () =>
    Effect.gen(function* () {
      const ownerAuth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada",
      });
      const otherAuth = yield* routes.register({
        username: "bob",
        email: "bob@example.com",
        password: "builderbob",
        displayName: "Bob",
      });
      const ownerToken = (ownerAuth.body as { token: string }).token;
      const otherToken = (otherAuth.body as { token: string }).token;
      const ownerHeader = `Bearer ${ownerToken}`;
      const otherHeader = `Bearer ${otherToken}`;

      const created = yield* routes.createPost(ownerHeader, {
        title: "Secret Draft",
        body: "shh",
        visibility: "private",
      });
      const slug = (created.body as { slug: string }).slug;

      const anonymousView = yield* routes.getPost(slug, undefined);
      const otherView = yield* routes.getPost(slug, otherHeader);
      const ownerView = yield* routes.getPost(slug, ownerHeader);
      const forbiddenDelete = yield* routes.deletePost(slug, otherHeader);

      return { anonymousView, otherView, ownerView, forbiddenDelete };
    }).pipe(Effect.provide(Store.Default));

  it("hides private posts from everyone but the author", async () => {
    const { anonymousView, otherView, ownerView, forbiddenDelete } = await Effect.runPromise(
      scenario() as Effect.Effect<{
        anonymousView: JsonResponse;
        otherView: JsonResponse;
        ownerView: JsonResponse;
        forbiddenDelete: JsonResponse;
      }>,
    );
    expect(anonymousView.status).toBe(404);
    expect(otherView.status).toBe(404);
    expect(ownerView.status).toBe(200);
    expect(forbiddenDelete.status).toBe(403);
  });
});

describe("comments", () => {
  it("requires a displayName for anonymous comments but not for registered ones", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada",
      });
      const token = (auth.body as { token: string }).token;
      const header = `Bearer ${token}`;
      const post = yield* routes.createPost(header, { title: "Post", body: "body", visibility: "public" });
      const slug = (post.body as { slug: string }).slug;

      const missingName = yield* routes.createComment(slug, undefined, { body: "hi" });
      const anonymousOk = yield* routes.createComment(slug, undefined, { body: "hi", displayName: "Guest" });
      const registeredOk = yield* routes.createComment(slug, header, { body: "hi" });

      return { missingName, anonymousOk, registeredOk };
    }).pipe(Effect.provide(Store.Default));

    const { missingName, anonymousOk, registeredOk } = await Effect.runPromise(
      program as Effect.Effect<{ missingName: JsonResponse; anonymousOk: JsonResponse; registeredOk: JsonResponse }>,
    );
    expect(missingName.status).toBe(400);
    expect(anonymousOk.status).toBe(201);
    expect(registeredOk.status).toBe(201);
  });
});
