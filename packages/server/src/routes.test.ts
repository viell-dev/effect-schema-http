import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as routes from "./routes.js";
import { Store } from "./store.js";
import type { RouteResponse } from "./httpError.js";

const run = <E>(effect: Effect.Effect<RouteResponse, E, Store>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Store.Default)) as Effect.Effect<RouteResponse, E>);

const jsonBody = (response: RouteResponse): unknown => {
  if (response.kind !== "json") throw new Error(`expected a JSON response, got "${response.kind}"`);
  return response.body;
};

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
    expect(jsonBody(response)).toMatchObject({ profile: { username: "ada" } });
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
      program as Effect.Effect<{ first: RouteResponse; second: RouteResponse }>,
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  it("rejects an invalid registration payload with 400", async () => {
    const response = await run(routes.register({ username: "a", email: "not-an-email", password: "short" }));
    expect(response.status).toBe(400);
    expect((jsonBody(response) as { issues: ReadonlyArray<string> }).issues.length).toBeGreaterThan(0);
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
    const response = await Effect.runPromise(program as Effect.Effect<RouteResponse>);
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
      const ownerToken = (jsonBody(ownerAuth) as { token: string }).token;
      const otherToken = (jsonBody(otherAuth) as { token: string }).token;
      const ownerHeader = `Bearer ${ownerToken}`;
      const otherHeader = `Bearer ${otherToken}`;

      const created = yield* routes.createPost(ownerHeader, {
        title: "Secret Draft",
        body: "shh",
        visibility: "private",
      });
      const slug = (jsonBody(created) as { slug: string }).slug;

      const anonymousView = yield* routes.getPost(slug, undefined);
      const otherView = yield* routes.getPost(slug, otherHeader);
      const ownerView = yield* routes.getPost(slug, ownerHeader);
      const forbiddenDelete = yield* routes.deletePost(slug, otherHeader);

      return { anonymousView, otherView, ownerView, forbiddenDelete };
    }).pipe(Effect.provide(Store.Default));

  it("hides private posts from everyone but the author", async () => {
    const { anonymousView, otherView, ownerView, forbiddenDelete } = await Effect.runPromise(
      scenario() as Effect.Effect<{
        anonymousView: RouteResponse;
        otherView: RouteResponse;
        ownerView: RouteResponse;
        forbiddenDelete: RouteResponse;
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
      const token = (jsonBody(auth) as { token: string }).token;
      const header = `Bearer ${token}`;
      const post = yield* routes.createPost(header, { title: "Post", body: "body", visibility: "public" });
      const slug = (jsonBody(post) as { slug: string }).slug;

      const missingName = yield* routes.createComment(slug, undefined, { body: "hi" });
      const anonymousOk = yield* routes.createComment(slug, undefined, { body: "hi", displayName: "Guest" });
      const registeredOk = yield* routes.createComment(slug, header, { body: "hi" });

      return { missingName, anonymousOk, registeredOk };
    }).pipe(Effect.provide(Store.Default));

    const { missingName, anonymousOk, registeredOk } = await Effect.runPromise(
      program as Effect.Effect<{ missingName: RouteResponse; anonymousOk: RouteResponse; registeredOk: RouteResponse }>,
    );
    expect(missingName.status).toBe(400);
    expect(anonymousOk.status).toBe(201);
    expect(registeredOk.status).toBe(201);
  });
});

describe("attachments", () => {
  const registerAndPost = () =>
    Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada",
      });
      const token = (jsonBody(auth) as { token: string }).token;
      const header = `Bearer ${token}`;
      const post = yield* routes.createPost(header, { title: "Post", body: "body", visibility: "public" });
      const slug = (jsonBody(post) as { slug: string }).slug;
      return { header, slug };
    });

  it("uploads a file, lists it, downloads its exact bytes, then deletes it", async () => {
    const program = Effect.gen(function* () {
      const { header, slug } = yield* registerAndPost();

      const formData = new FormData();
      const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
      formData.set("file", new File([bytes], "cover.png", { type: "image/png" }));
      formData.set("caption", "a tiny fake PNG");

      const uploaded = yield* routes.uploadAttachment(slug, header, formData);
      const meta = jsonBody(uploaded) as { id: string; filename: string; size: number };

      const listed = yield* routes.listAttachments(slug, undefined);
      const downloaded = yield* routes.getAttachmentBytes(slug, meta.id, undefined);
      const deleted = yield* routes.deleteAttachment(slug, meta.id, header);
      const listedAfterDelete = yield* routes.listAttachments(slug, undefined);

      return { meta, uploaded, listed, downloaded, deleted, listedAfterDelete, bytes };
    }).pipe(Effect.provide(Store.Default));

    const { meta, uploaded, listed, downloaded, deleted, listedAfterDelete, bytes } = await Effect.runPromise(
      program as Effect.Effect<{
        meta: { id: string; filename: string; size: number };
        uploaded: RouteResponse;
        listed: RouteResponse;
        downloaded: RouteResponse;
        deleted: RouteResponse;
        listedAfterDelete: RouteResponse;
        bytes: Uint8Array;
      }>,
    );

    expect(uploaded.status).toBe(201);
    expect(meta.filename).toBe("cover.png");
    expect(meta.size).toBe(bytes.length);
    expect((jsonBody(listed) as { attachments: ReadonlyArray<unknown> }).attachments).toHaveLength(1);
    expect(downloaded.kind).toBe("bytes");
    if (downloaded.kind === "bytes") {
      expect(downloaded.contentType).toBe("image/png");
      expect(Array.from(downloaded.body)).toEqual(Array.from(bytes));
    }
    expect(deleted.status).toBe(204);
    expect((jsonBody(listedAfterDelete) as { attachments: ReadonlyArray<unknown> }).attachments).toHaveLength(0);
  });

  it("rejects an attachment upload from a non-author with 403", async () => {
    const program = Effect.gen(function* () {
      const { slug } = yield* registerAndPost();
      const otherAuth = yield* routes.register({
        username: "bob",
        email: "bob@example.com",
        password: "builderbob",
        displayName: "Bob",
      });
      const otherHeader = `Bearer ${(jsonBody(otherAuth) as { token: string }).token}`;

      const formData = new FormData();
      formData.set("file", new File([new Uint8Array([1])], "x.bin", { type: "application/octet-stream" }));
      return yield* routes.uploadAttachment(slug, otherHeader, formData);
    }).pipe(Effect.provide(Store.Default));

    const response = await Effect.runPromise(program as Effect.Effect<RouteResponse>);
    expect(response.status).toBe(403);
  });
});

describe("blog feed", () => {
  it("serves a text/XML Atom feed containing only public posts", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada",
      });
      const header = `Bearer ${(jsonBody(auth) as { token: string }).token}`;
      yield* routes.createPost(header, { title: "Public One", body: "body", visibility: "public" });
      yield* routes.createPost(header, { title: "A Secret", body: "body", visibility: "private" });
      return yield* routes.getBlogFeed("ada");
    }).pipe(Effect.provide(Store.Default));

    const response = await Effect.runPromise(program as Effect.Effect<RouteResponse>);
    expect(response.status).toBe(200);
    expect(response.kind).toBe("text");
    if (response.kind === "text") {
      expect(response.contentType).toContain("atom+xml");
      expect(response.body).toContain("Public One");
      expect(response.body).not.toContain("A Secret");
    }
  });
});

describe("admin", () => {
  it("makes the first registered account an admin and later ones ordinary members", async () => {
    const program = Effect.gen(function* () {
      const first = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada",
      });
      const second = yield* routes.register({
        username: "bob",
        email: "bob@example.com",
        password: "builderbob",
        displayName: "Bob",
      });
      const firstToken = (jsonBody(first) as { token: string }).token;
      const secondToken = (jsonBody(second) as { token: string }).token;
      const firstMe = yield* routes.currentUser(`Bearer ${firstToken}`);
      const secondMe = yield* routes.currentUser(`Bearer ${secondToken}`);
      const statsAsAdmin = yield* routes.adminStats(`Bearer ${firstToken}`);
      const statsAsMember = yield* routes.adminStats(`Bearer ${secondToken}`);
      const refreshed = yield* routes.adminRefreshCache(`Bearer ${firstToken}`, { reason: "test" });
      return { firstMe, secondMe, statsAsAdmin, statsAsMember, refreshed };
    }).pipe(Effect.provide(Store.Default));

    const { firstMe, secondMe, statsAsAdmin, statsAsMember, refreshed } = await Effect.runPromise(
      program as Effect.Effect<{
        firstMe: RouteResponse;
        secondMe: RouteResponse;
        statsAsAdmin: RouteResponse;
        statsAsMember: RouteResponse;
        refreshed: RouteResponse;
      }>,
    );

    expect((jsonBody(firstMe) as { role: string }).role).toBe("admin");
    expect((jsonBody(secondMe) as { role: string }).role).toBe("member");
    expect(statsAsAdmin.status).toBe(200);
    expect(statsAsAdmin.kind).toBe("bytes");
    if (statsAsAdmin.kind === "bytes") {
      const stats = JSON.parse(new TextDecoder().decode(statsAsAdmin.body)) as { users: number };
      expect(stats.users).toBe(2);
    }
    expect(statsAsMember.status).toBe(403);
    // 205 Reset Content: the admin "refresh cache" RPC has no body at all, unlike the 204s used
    // for deletes elsewhere - see admin.ts for why this one specifically uses 205.
    expect(refreshed.status).toBe(205);
    expect(refreshed.kind).toBe("empty");
  });
});
