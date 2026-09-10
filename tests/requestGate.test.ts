/** Server-backed coverage of request-gate de-duplication and provider cancellation. */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpClient } from "@effect/platform";
import { Cause, Effect, Either, Exit, Fiber, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApi, makeRequestGate, response } from "../src/main.js";

const Filters = Schema.Struct({
  page: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  search: Schema.String.pipe(Schema.minLength(1)),
});
type FiltersInput = typeof Filters.Encoded;

const Users = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    request: Schema.Number,
  }),
);
const NotFound = Schema.Struct({ search: Schema.String, request: Schema.Number });

const sendJson = (outgoing: ServerResponse, status: number, body: unknown): void => {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
};

describe("request gates over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let requests = 0;
  let abortStarted: Promise<void>;
  let abortObserved: Promise<void>;
  let markAbortStarted: (() => void) | undefined;
  let markAbortObserved: (() => void) | undefined;

  beforeAll(async () => {
    server = createServer((request, outgoing) => {
      const handle = async () => {
        requests += 1;
        const url = new URL(request.url ?? "/", "http://localhost");
        const search = url.searchParams.get("search") ?? "";

        if (url.pathname !== "/users") {
          sendJson(outgoing, 404, { search, request: requests });
          return;
        }
        if (search === "missing") {
          sendJson(outgoing, 404, { search, request: requests });
          return;
        }
        if (search === "abort") {
          markAbortStarted?.();
          outgoing.once("close", () => markAbortObserved?.());
          return;
        }
        if (search === "slow") await new Promise((resolve) => setTimeout(resolve, 25));

        sendJson(outgoing, 200, [{ id: "user-1", name: search, request: requests }]);
      };

      handle().catch((error: unknown) => sendJson(outgoing, 500, { error: String(error) }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    requests = 0;
    abortStarted = new Promise((resolve) => {
      markAbortStarted = resolve;
    });
    abortObserved = new Promise((resolve) => {
      markAbortObserved = resolve;
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  const makeUsersGate = Effect.gen(function* () {
    const getUsers = createApi(baseUrl).createRequest({
      method: "GET",
      path: "/users",
      responses: [response({ _tag: "ok", status: 200 }, Users), response({ _tag: "not-found", status: 404 }, NotFound)],
    });

    return yield* makeRequestGate(
      (input: FiltersInput) =>
        Schema.decodeUnknown(Filters)(input).pipe(
          Effect.flatMap(
            (filters) => getUsers().setUrlParams({ page: String(filters.page), search: filters.search }).effect,
          ),
        ),
      { key: ({ page, search }) => JSON.stringify([page, search]) },
    );
  });

  it("retains a valid table response across an invalid intermediate form state", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* makeUsersGate;
      const first = yield* gate.run({ page: 1, search: "Ada" });
      const invalid = yield* gate.run({ page: 1, search: "" }).pipe(Effect.either);
      const restored = yield* gate.run({ page: 1, search: "Ada" });
      const refreshed = yield* gate.reload;
      return { first, invalid, restored, refreshed };
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const result = await Effect.runPromise(program);

    expect(result.first).toMatchObject({ _tag: "ok", body: [{ name: "Ada", request: 1 }] });
    expect(Either.isLeft(result.invalid)).toBe(true);
    expect(result.restored).toBe(result.first);
    expect(result.refreshed).toMatchObject({ _tag: "ok", body: [{ name: "Ada", request: 2 }] });
    expect(requests).toBe(2);
  });

  it("coalesces concurrent HTTP calls and retains mapped non-2xx responses", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* makeUsersGate;
      const slow = yield* Effect.all([gate.run({ page: 1, search: "slow" }), gate.run({ page: 1, search: "slow" })], {
        concurrency: "unbounded",
      });
      const missing = yield* gate.run({ page: 1, search: "missing" });
      const missingAgain = yield* gate.run({ page: 1, search: "missing" });
      return { slow, missing, missingAgain };
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const result = await Effect.runPromise(program);

    expect(result.slow[0]).toBe(result.slow[1]);
    expect(result.slow[0]).toMatchObject({ _tag: "ok", body: [{ name: "slow", request: 1 }] });
    expect(result.missing).toMatchObject({ _tag: "not-found", body: { search: "missing", request: 2 } });
    expect(result.missingAgain).toBe(result.missing);
    expect(requests).toBe(2);
  });

  it("aborts an in-flight Fetch request when the gate is invalidated", async () => {
    const program = Effect.gen(function* () {
      const gate = yield* makeUsersGate;
      const executing = yield* Effect.fork(gate.run({ page: 1, search: "abort" }));
      yield* Effect.promise(() => abortStarted);
      const waiter = yield* Effect.fork(gate.run({ page: 1, search: "abort" }));
      yield* Effect.yieldNow();
      yield* gate.invalidate;
      return yield* Effect.all([Fiber.await(executing), Fiber.await(waiter)]);
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const [executing, waiter] = await Effect.runPromise(program);
    await abortObserved;

    expect(Exit.isFailure(executing) && Cause.isInterruptedOnly(executing.cause)).toBe(true);
    expect(Exit.isFailure(waiter) && Cause.isInterruptedOnly(waiter.cause)).toBe(true);
    expect(requests).toBe(1);
  });
});
