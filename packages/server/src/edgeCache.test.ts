import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { edgeCacheClear, edgeCacheKey, edgeCacheLookup, edgeCacheStore } from "./edgeCache.js";
import * as routes from "./routes.js";
import { Store } from "./store.js";
import type { RouteResponse } from "./httpError.js";

const feedResponse = (marker: string): RouteResponse => ({ kind: "json", status: 200, body: { marker } });

const jsonBody = (response: RouteResponse): unknown => {
  if (response.kind !== "json") throw new Error(`expected a JSON response, got "${response.kind}"`);
  return response.body;
};

describe("edge cache", () => {
  beforeEach(() => edgeCacheClear());

  it("fronts only the two routes that do not vary by viewer", () => {
    expect(edgeCacheKey("GET", "/api/posts", "")).toBe("GET /api/posts");
    expect(edgeCacheKey("GET", "/api/blogs/ada/feed.atom", "")).toBe("GET /api/blogs/ada/feed.atom");

    // Everything else passes straight through: a blog page, a post, and anything authenticated
    // all change shape depending on who is asking.
    expect(edgeCacheKey("GET", "/api/blogs/ada", "")).toBeUndefined();
    expect(edgeCacheKey("GET", "/api/posts/hello-world", "")).toBeUndefined();
    expect(edgeCacheKey("GET", "/api/admin/users", "?name=ada")).toBeUndefined();
    // Only reads are cached.
    expect(edgeCacheKey("POST", "/api/posts", "")).toBeUndefined();
  });

  it("serves a stored response and reports it as a hit", () => {
    const key = edgeCacheKey("GET", "/api/posts", "")!;
    expect(edgeCacheLookup(key)).toBeUndefined();

    const stored = edgeCacheStore(key, feedResponse("first"));
    expect(stored.headers?.["x-cache"]).toBe("MISS");
    expect(stored.headers?.["cache-control"]).toContain("max-age=");

    const hit = edgeCacheLookup(key);
    expect(hit?.headers?.["x-cache"]).toBe("HIT");
    expect(hit?.headers?.["age"]).toBe("0");
    expect(jsonBody(hit!)).toEqual({ marker: "first" });
  });

  it("is bypassed by a query string it has not seen, but not by request cache directives", () => {
    const plain = edgeCacheKey("GET", "/api/posts", "")!;
    const busted = edgeCacheKey("GET", "/api/posts", "?_=1789126000000")!;
    edgeCacheStore(plain, feedResponse("stale"));

    // The key includes the query string, so a throwaway parameter misses; this is the only
    // bypass this proxy has ever supported.
    expect(plain).not.toBe(busted);
    expect(edgeCacheLookup(busted)).toBeUndefined();

    // And there is deliberately no way to pass a request `Cache-Control` in: lookup takes only a
    // key, because the proxy never reads one.
    expect(jsonBody(edgeCacheLookup(plain)!)).toEqual({ marker: "stale" });
  });

  it("caches only successful responses", () => {
    const key = edgeCacheKey("GET", "/api/posts", "")!;
    const stored = edgeCacheStore(key, { kind: "json", status: 500, body: { message: "boom" } });
    expect(stored.headers?.["x-cache"]).toBe("MISS");
    expect(edgeCacheLookup(key)).toBeUndefined();
  });

  it("is purged by the admin cache-refresh command", async () => {
    const key = edgeCacheKey("GET", "/api/posts", "")!;
    edgeCacheStore(key, feedResponse("before"));
    expect(edgeCacheLookup(key)).toBeDefined();

    const program = Effect.gen(function* () {
      const auth = yield* routes.register({
        username: "ada",
        email: "ada@example.com",
        password: "lovelace1",
        displayName: "Ada Lovelace",
      });
      const { token } = jsonBody(auth) as { token: string };
      return yield* routes.adminRefreshCache(`Bearer ${token}`, { reason: "feed looked stale" });
    }).pipe(Effect.provide(Store.Default));

    const refreshed = await Effect.runPromise(program as Effect.Effect<RouteResponse>);

    expect(refreshed.status).toBe(205);
    expect(edgeCacheLookup(key)).toBeUndefined();
  });
});
