import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Match, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { createApi, response, ResponseBody } from "../src/main.js";

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
});
const CreateUser = Schema.Struct({ name: Schema.String, email: Schema.String });
const ReplaceUser = Schema.Struct({ name: Schema.String, email: Schema.String });
const UpdateUser = Schema.Struct({
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const BlogPost = Schema.Struct({ id: Schema.String, userId: Schema.String, title: Schema.String });
const NotFound = Schema.Struct({ resource: Schema.String, id: Schema.String });
const Gone = Schema.Struct({ id: Schema.String, deletedAt: Schema.String });
const Conflict = Schema.Struct({ current: User, requested: UpdateUser });
const NotImplemented = Schema.Struct({ feature: Schema.String, fallback: Schema.String });

const userId = "8fb4c850-8527-4f1c-927a-37c01ffddf70";
const postId = "a7e54aa7-0840-4de0-b07a-41a1485e76a1";

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const sendJson = (outgoing: ServerResponse, status: number, body: unknown): void => {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
};

describe("request integration", () => {
  let server: Server;
  let baseUrl: string;
  let currentUser: typeof User.Type = { id: userId, name: "Ada", email: "ada@example.test" };
  const methods: Array<string> = [];

  beforeAll(async () => {
    server = createServer((request, outgoing) => {
      const handle = async () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const segments = url.pathname
          .split("/")
          .filter(Boolean)
          .map((segment) => decodeURIComponent(segment));
        const method = request.method ?? "GET";
        methods.push(method);

        if (method === "POST" && url.pathname === "/users") {
          const body = (await readJson(request)) as typeof CreateUser.Type;
          currentUser = { id: userId, ...body };
          sendJson(outgoing, 201, currentUser);
          return;
        }

        if (method === "OPTIONS" && url.pathname === "/users") {
          outgoing.writeHead(204, { allow: "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS" });
          outgoing.end();
          return;
        }

        if (method === "GET" && url.pathname === "/features/new-dashboard") {
          sendJson(outgoing, 501, { feature: "new-dashboard", fallback: "/features/legacy-dashboard" });
          return;
        }

        if (segments[0] === "users" && segments[2] === "posts" && segments[1] && segments[3]) {
          sendJson(outgoing, 200, { id: segments[3], userId: segments[1], title: "Typed HTTP" });
          return;
        }

        if (segments[0] !== "users" || segments.length !== 2 || segments[1] === undefined) {
          sendJson(outgoing, 404, { resource: "route", id: url.pathname });
          return;
        }

        const requestedId = segments[1];
        if (requestedId === "gone") {
          sendJson(outgoing, 410, { id: requestedId, deletedAt: "2026-09-09T12:00:00Z" });
          return;
        }
        if (requestedId !== userId) {
          sendJson(outgoing, 404, { resource: "user", id: requestedId });
          return;
        }

        if (method === "GET") {
          sendJson(outgoing, 200, currentUser);
          return;
        }
        if (method === "HEAD") {
          outgoing.writeHead(200, { "x-user-name": currentUser.name });
          outgoing.end();
          return;
        }
        if (method === "PROPFIND") {
          sendJson(outgoing, 207, currentUser);
          return;
        }
        if (method === "PUT") {
          const body = (await readJson(request)) as typeof ReplaceUser.Type;
          currentUser = { id: userId, ...body };
          sendJson(outgoing, 200, currentUser);
          return;
        }
        if (method === "PATCH") {
          const body = (await readJson(request)) as typeof UpdateUser.Type;
          if (body.name === "Taken" && url.searchParams.get("force") !== "true") {
            sendJson(outgoing, 409, { current: currentUser, requested: body });
            return;
          }
          currentUser = { ...currentUser, ...body };
          sendJson(outgoing, 200, currentUser);
          return;
        }
        if (method === "DELETE") {
          outgoing.writeHead(204);
          outgoing.end();
          return;
        }

        sendJson(outgoing, 404, { resource: "method", id: method });
      };

      handle().catch((error: unknown) => {
        sendJson(outgoing, 500, { message: String(error) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    currentUser = { id: userId, name: "Ada", email: "ada@example.test" };
    methods.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it("supports standard and extension methods with typed path segments", async () => {
    const api = createApi(baseUrl, {
      responses: [
        response({ _tag: "not-found", status: 404 }, NotFound),
        response({ _tag: "not-implemented", status: 501 }, NotImplemented),
      ] as const,
    });
    const createUser = api.createRequest({
      method: "POST",
      path: "/users",
      body: CreateUser,
      responses: [response({ _tag: "created", status: 201 }, User)] as const,
    });
    const getUser = api.createRequest({
      method: "GET",
      path: "/users/:userId",
      responses: [response({ _tag: "ok", status: 200 }, User), response({ _tag: "gone", status: 410 }, Gone)] as const,
    });
    const replaceUser = api.createRequest({
      method: "PUT",
      path: "/users/:userId",
      body: ReplaceUser,
      responses: [response({ _tag: "ok", status: 200 }, User)] as const,
    });
    const updateUser = api.createRequest({
      method: "PATCH",
      path: "/users/:userId",
      body: UpdateUser,
      responses: [
        response({ _tag: "ok", status: 200 }, User),
        response({ _tag: "conflict", status: 409 }, Conflict),
      ] as const,
    });
    const deleteUser = api.createRequest({
      method: "DELETE",
      path: "/users/:userId",
      responses: [response({ _tag: "deleted", status: 204 }, Schema.Void, { codec: ResponseBody.none })] as const,
    });
    const headUser = api.createRequest({
      method: "HEAD",
      path: "/users/:userId",
      responses: [
        response({ _tag: "exists", status: 200, headers: { "x-user-name": "Taken" } }, Schema.Void, {
          codec: ResponseBody.none,
        }),
      ] as const,
    });
    const inspectUser = api.createRequest({
      method: "PROPFIND",
      path: "/users/:userId",
      responses: [response({ _tag: "properties", status: 207 }, User)],
    });
    const usersOptions = api.createRequest({
      method: "OPTIONS",
      path: "/users",
      responses: [response({ _tag: "options", status: 204 }, Schema.Void, { codec: ResponseBody.none })] as const,
    });
    const getUserBlogPost = api.createRequest({
      method: "GET",
      path: "/users/:userId/posts/:postId",
      responses: [response({ _tag: "ok", status: 200 }, BlogPost)] as const,
    });

    expectTypeOf(getUser).parameters.toEqualTypeOf<[value: string]>();
    expectTypeOf(getUserBlogPost).parameters.toEqualTypeOf<[value: string, value: string]>();

    const created = await createUser()
      .setBody({ name: "Ada", email: "ada@example.test" })
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(created).toMatchObject({ _tag: "created", status: 201, body: { id: userId, name: "Ada" } });

    const fetched = await getUser(userId).effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(fetched).toMatchObject({ _tag: "ok", body: { id: userId, name: "Ada" } });

    const inspected = await inspectUser(userId).effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(inspected).toMatchObject({ _tag: "properties", status: 207, body: { id: userId } });

    const replaced = await replaceUser(userId)
      .setBody({ name: "Grace", email: "grace@example.test" })
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    if (replaced._tag !== "ok") {
      throw new Error(`Expected ok response, received ${replaced._tag}`);
    }
    expect(replaced.body.name).toBe("Grace");

    const conflict = await updateUser(userId)
      .setBody({ name: "Taken" })
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(conflict._tag).toBe("conflict");
    const conflictMessage = Match.value(conflict).pipe(
      Match.tag("conflict", ({ body }) => `${body.requested.name} conflicts with ${body.current.name}`),
      Match.tag("ok", ({ body }) => body.name),
      Match.tag("not-found", ({ body }) => body.resource),
      Match.tag("not-implemented", ({ body }) => body.fallback),
      Match.exhaustive,
    );
    expect(conflictMessage).toBe("Taken conflicts with Grace");

    const forced = await updateUser(userId)
      .setUrlParam("force", "true")
      .setBody({ name: "Taken" })
      .effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(forced).toMatchObject({ _tag: "ok", body: { name: "Taken" } });

    const head = await headUser(userId).effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(head).toMatchObject({ _tag: "exists", headers: { "x-user-name": "Taken" } });

    const post = await getUserBlogPost(userId, postId).effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );
    expect(post.body).toEqual({ id: postId, userId, title: "Typed HTTP" });

    const options = await usersOptions().effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(options).toMatchObject({ _tag: "options", status: 204 });

    const deleted = await deleteUser(userId).effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    expect(deleted).toMatchObject({ _tag: "deleted", status: 204 });

    expect(methods).toEqual(["POST", "GET", "PROPFIND", "PUT", "PATCH", "PATCH", "HEAD", "GET", "OPTIONS", "DELETE"]);
  });

  it("returns mapped 404, 410, and 501 responses as ordinary discriminated values", async () => {
    const api = createApi(baseUrl, {
      responses: [
        response({ _tag: "not-found", status: 404 }, NotFound),
        response({ _tag: "not-implemented", status: 501 }, NotImplemented),
      ] as const,
    });
    const getUser = api.createRequest({
      method: "GET",
      path: "/users/:userId",
      responses: [response({ _tag: "ok", status: 200 }, User), response({ _tag: "gone", status: 410 }, Gone)] as const,
    });
    const getFeature = api.createRequest({
      method: "GET",
      path: "/features/:feature",
    });

    const missing = await getUser("missing").effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    const gone = await getUser("gone").effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
    const unsupported = await getFeature("new-dashboard").effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise,
    );

    expect(missing).toMatchObject({ _tag: "not-found", status: 404, body: { resource: "user" } });
    expect(gone).toMatchObject({ _tag: "gone", status: 410 });
    expect(unsupported).toMatchObject({ _tag: "not-implemented", status: 501 });
  });
});
