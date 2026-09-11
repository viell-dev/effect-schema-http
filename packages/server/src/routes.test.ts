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

  it("filters the user directory by name and email substring, admin-only", async () => {
    const program = Effect.gen(function* () {
      const admin = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      yield* routes.register({
        username: "bob",
        email: "bob@example.com",
        password: "builderbob",
        displayName: "Bob Builder",
      });
      yield* routes.register({
        username: "carol",
        email: "carol@other.example",
        password: "carolcarol",
        displayName: "Carol Danvers",
      });
      const adminHeader = `Bearer ${(jsonBody(admin) as { token: string }).token}`;

      const all = yield* routes.adminListUsers(adminHeader, undefined, undefined);
      const byName = yield* routes.adminListUsers(adminHeader, "bob", undefined);
      const byEmail = yield* routes.adminListUsers(adminHeader, undefined, "other.example");
      const asNonAdmin = yield* routes.adminListUsers(undefined, undefined, undefined);

      return { all, byName, byEmail, asNonAdmin };
    }).pipe(Effect.provide(Store.Default));

    const { all, byName, byEmail, asNonAdmin } = await Effect.runPromise(
      program as Effect.Effect<{
        all: RouteResponse;
        byName: RouteResponse;
        byEmail: RouteResponse;
        asNonAdmin: RouteResponse;
      }>,
    );

    expect((jsonBody(all) as { users: ReadonlyArray<unknown> }).users).toHaveLength(3);
    const byNameUsers = (jsonBody(byName) as { users: ReadonlyArray<{ username: string }> }).users;
    expect(byNameUsers.map((u) => u.username)).toEqual(["bob"]);
    const byEmailUsers = (jsonBody(byEmail) as { users: ReadonlyArray<{ username: string }> }).users;
    expect(byEmailUsers.map((u) => u.username)).toEqual(["carol"]);
    expect(asNonAdmin.status).toBe(401);
  });
});

describe("legacy request formats", () => {
  it("authenticates through the form-encoded login exactly like the JSON one", async () => {
    const program = Effect.gen(function* () {
      yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });

      // Exactly the flat record `RequestBody.urlParams` produces on the wire.
      const ok = yield* routes.legacyLogin({
        email: "ada@example.com",
        password: "lovelace1",
        grant_type: "password",
      });
      const wrongPassword = yield* routes.legacyLogin({
        email: "ada@example.com",
        password: "not-the-password",
        grant_type: "password",
      });
      const wrongGrant = yield* routes.legacyLogin({
        email: "ada@example.com",
        password: "lovelace1",
        grant_type: "client_credentials",
      });

      return { ok, wrongPassword, wrongGrant };
    }).pipe(Effect.provide(Store.Default));

    const { ok, wrongPassword, wrongGrant } = await Effect.runPromise(
      program as Effect.Effect<{ ok: RouteResponse; wrongPassword: RouteResponse; wrongGrant: RouteResponse }>,
    );

    expect(ok.status).toBe(200);
    expect(jsonBody(ok)).toMatchObject({ profile: { username: "ada" } });
    expect(wrongPassword.status).toBe(401);
    // An unexpected grant type is a schema failure, not an auth failure.
    expect(wrongGrant.status).toBe(400);
  });

  it("imports an Atom document the feed endpoint itself could have produced", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      const header = `Bearer ${(jsonBody(auth) as { token: string }).token}`;
      yield* routes.createPost(header, { title: "Existing post", body: "Already here.", visibility: "public" });

      const xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        "  <title>Ada Lovelace</title>",
        "  <updated>2026-01-02T03:04:05.000Z</updated>",
        "  <entry>",
        "    <title>Existing post</title>",
        '    <link href="http://old.example/1"/>',
        "    <updated>2026-01-02T03:04:05.000Z</updated>",
        "  </entry>",
        "  <entry>",
        "    <title>Brand new post</title>",
        '    <link href="http://old.example/2"/>',
        "    <updated>2026-01-03T03:04:05.000Z</updated>",
        "  </entry>",
        "</feed>",
      ].join("\n");

      const imported = yield* routes.importAtom("ada", header, xml);
      const malformed = yield* routes.importAtom("ada", header, "<html>not a feed</html>");
      const unauthenticated = yield* routes.importAtom("ada", undefined, xml);
      const feed = yield* routes.getBlogFeed("ada");

      return { imported, malformed, unauthenticated, feed };
    }).pipe(Effect.provide(Store.Default));

    const { imported, malformed, unauthenticated, feed } = await Effect.runPromise(
      program as Effect.Effect<{
        imported: RouteResponse;
        malformed: RouteResponse;
        unauthenticated: RouteResponse;
        feed: RouteResponse;
      }>,
    );

    expect(imported.status).toBe(200);
    expect(jsonBody(imported)).toMatchObject({ imported: 1, skipped: 1 });
    expect(malformed.status).toBe(400);
    expect(unauthenticated.status).toBe(401);
    // Round trip: what the importer accepted now comes back out of the feed it mirrors.
    expect(feed.kind === "text" && feed.body).toContain("Brand new post");
  });
});

describe("export, reindex, and bundles", () => {
  it("answers the same post as JSON or Markdown depending on Accept", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      const header = `Bearer ${(jsonBody(auth) as { token: string }).token}`;
      yield* routes.createPost(header, { title: "Hello world", body: "First line.", visibility: "public" });

      const asJson = yield* routes.exportPost("hello-world", header, "application/json");
      const asMarkdown = yield* routes.exportPost("hello-world", header, "text/markdown, text/plain;q=0.9");
      const missing = yield* routes.exportPost("no-such-post", header, "application/json");

      return { asJson, asMarkdown, missing };
    }).pipe(Effect.provide(Store.Default));

    const { asJson, asMarkdown, missing } = await Effect.runPromise(
      program as Effect.Effect<{ asJson: RouteResponse; asMarkdown: RouteResponse; missing: RouteResponse }>,
    );

    expect(asJson.kind).toBe("json");
    expect(jsonBody(asJson)).toMatchObject({ slug: "hello-world", author: "ada" });
    expect(asMarkdown.kind).toBe("text");
    expect(asMarkdown.kind === "text" && asMarkdown.contentType).toContain("text/markdown");
    expect(asMarkdown.kind === "text" && asMarkdown.body).toContain("---\nslug: hello-world");
    expect(missing.status).toBe(404);
  });

  it("answers 503 with Retry-After until the search cluster has warmed up", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      const header = `Bearer ${(jsonBody(auth) as { token: string }).token}`;

      const first = yield* routes.adminReindex(header);
      const second = yield* routes.adminReindex(header);
      const third = yield* routes.adminReindex(header);
      const asAnonymous = yield* routes.adminReindex(undefined);

      return { first, second, third, asAnonymous };
    }).pipe(Effect.provide(Store.Default));

    const { first, second, third, asAnonymous } = await Effect.runPromise(
      program as Effect.Effect<{
        first: RouteResponse;
        second: RouteResponse;
        third: RouteResponse;
        asAnonymous: RouteResponse;
      }>,
    );

    expect([first.status, second.status, third.status]).toEqual([503, 503, 202]);
    expect(first.headers?.["retry-after"]).toBe("1");
    expect(jsonBody(third)).toMatchObject({ attempts: 3 });
    expect(asAnonymous.status).toBe(401);
  });

  it("bundles one attachment's metadata and bytes into a multipart response", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      const header = `Bearer ${(jsonBody(auth) as { token: string }).token}`;
      yield* routes.createPost(header, { title: "Hello world", body: "First line.", visibility: "public" });

      const form = new FormData();
      form.set("file", new Blob(["hello bytes"], { type: "text/plain" }), "note.txt");
      form.set("caption", "A note");
      const uploaded = yield* routes.uploadAttachment("hello-world", header, form);
      const attachmentId = (jsonBody(uploaded) as { id: string }).id;

      const bundle = yield* routes.attachmentBundle("hello-world", attachmentId, header);
      const missing = yield* routes.attachmentBundle("hello-world", "not-a-uuid", header);

      return { bundle, missing };
    }).pipe(Effect.provide(Store.Default));

    const { bundle, missing } = await Effect.runPromise(
      program as Effect.Effect<{ bundle: RouteResponse; missing: RouteResponse }>,
    );

    expect(bundle.status).toBe(200);
    if (bundle.kind !== "bytes") throw new Error("expected a byte response");
    expect(bundle.contentType).toContain("multipart/form-data; boundary=");

    // Parse it back the way the client's `ResponseBody.formData` codec will.
    const parsed = await new Response(bundle.body as BodyInit, {
      headers: { "content-type": bundle.contentType },
    }).formData();
    expect(JSON.parse(parsed.get("metadata") as string)).toMatchObject({
      filename: "note.txt",
      contentType: "text/plain",
      size: 11,
    });
    expect(await (parsed.get("file") as File).text()).toBe("hello bytes");
    expect(missing.status).toBe(400);
  });
});

describe("diagnostics", () => {
  it("answers modelled JSON normally and the watchdog's unmodelled text when degraded", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      const header = `Bearer ${(jsonBody(auth) as { token: string }).token}`;

      const healthy = yield* routes.adminDiagnostics(header, false);
      const degraded = yield* routes.adminDiagnostics(header, true);
      const asAnonymous = yield* routes.adminDiagnostics(undefined, false);

      return { healthy, degraded, asAnonymous };
    }).pipe(Effect.provide(Store.Default));

    const { healthy, degraded, asAnonymous } = await Effect.runPromise(
      program as Effect.Effect<{ healthy: RouteResponse; degraded: RouteResponse; asAnonymous: RouteResponse }>,
    );

    expect(healthy.status).toBe(200);
    expect(jsonBody(healthy)).toMatchObject({ subsystem: "modern", healthy: true });
    // The shape the client deliberately does not model.
    expect(degraded.status).toBe(503);
    expect(degraded.kind).toBe("text");
    expect(degraded.kind === "text" && degraded.contentType).toContain("text/plain");
    expect(degraded.kind === "text" && degraded.body).toContain("WATCHDOG DIAGNOSTIC DUMP");
    expect(asAnonymous.status).toBe(401);
  });
});

describe("optimistic concurrency on post updates", () => {
  const setup = () =>
    Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      const header = `Bearer ${(jsonBody(auth) as { token: string }).token}`;
      const created = yield* routes.createPost(header, {
        title: "Hello world",
        body: "First version.",
        visibility: "public",
      });
      const revision = (jsonBody(created) as { updatedAt: string }).updatedAt;
      return { header, revision };
    });

  it("accepts a write whose expected revision still matches", async () => {
    const program = Effect.gen(function* () {
      const { header, revision } = yield* setup();
      return yield* routes.updatePost("hello-world", header, { body: "Second version." }, revision, undefined);
    }).pipe(Effect.provide(Store.Default));

    const response = await Effect.runPromise(program as Effect.Effect<RouteResponse>);
    expect(response.status).toBe(200);
    expect(jsonBody(response)).toMatchObject({ body: "Second version." });
  });

  it("refuses a write whose expected revision is stale, naming when it changed", async () => {
    const program = Effect.gen(function* () {
      const { header, revision } = yield* setup();
      // Somebody else saves first, moving the post on.
      const theirs = yield* routes.updatePost("hello-world", header, { body: "Their version." }, revision, undefined);
      const theirRevision = (jsonBody(theirs) as { updatedAt: string }).updatedAt;
      // Our editor still holds the revision from before their save.
      const ours = yield* routes.updatePost("hello-world", header, { body: "Our version." }, revision, undefined);
      const after = yield* routes.getPost("hello-world", header);
      return { ours, theirRevision, after };
    }).pipe(Effect.provide(Store.Default));

    const { ours, theirRevision, after } = await Effect.runPromise(
      program as Effect.Effect<{ ours: RouteResponse; theirRevision: string; after: RouteResponse }>,
    );

    expect(ours.status).toBe(409);
    expect((jsonBody(ours) as { message: string }).message).toContain(theirRevision);
    // The refusal is a refusal: their version survived untouched.
    expect(jsonBody(after)).toMatchObject({ body: "Their version." });
  });

  it("overwrites when the caller forces it, and skips the check for clients that never send one", async () => {
    const program = Effect.gen(function* () {
      const { header, revision } = yield* setup();
      yield* routes.updatePost("hello-world", header, { body: "Their version." }, revision, undefined);

      // The replayed request: same stale revision, plus the override the dialog opted into.
      const forced = yield* routes.updatePost("hello-world", header, { body: "Our version." }, revision, "true");
      const afterForce = yield* routes.getPost("hello-world", header);

      // An older client that knows nothing about revisions is unaffected by any of this.
      const legacy = yield* routes.updatePost("hello-world", header, { body: "Legacy version." }, undefined, undefined);

      return { forced, afterForce, legacy };
    }).pipe(Effect.provide(Store.Default));

    const { forced, afterForce, legacy } = await Effect.runPromise(
      program as Effect.Effect<{ forced: RouteResponse; afterForce: RouteResponse; legacy: RouteResponse }>,
    );

    expect(forced.status).toBe(200);
    expect(jsonBody(afterForce)).toMatchObject({ body: "Our version." });
    expect(legacy.status).toBe(200);
  });
});
