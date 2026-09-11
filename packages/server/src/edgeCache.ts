/**
 * The reverse proxy that sits in front of this API in production, emulated in-process.
 *
 * It was put there years ago when the feed page started timing out under load, and it has never
 * been touched since. Two things about it matter to anything calling this API:
 *
 * 1. **It only fronts the two routes that do not vary by viewer.** `GET /api/posts` and the Atom
 *    feeds take no session into account at all, so caching them is safe. Nobody ever extended it
 *    to the rest of the API, because everything else changes shape depending on who is asking —
 *    a blog page shows its owner their own drafts — and the proxy has no notion of that.
 * 2. **It predates anyone caring about `Cache-Control` on requests.** It ignores `no-cache` and
 *    `Pragma` outright. The only thing that reliably gets a fresh response out of it is a query
 *    string it has not seen before, which is why every internal tool that needs live data appends
 *    a throwaway parameter. That is a real, if embarrassing, constraint on its callers, and
 *    `packages/web/src/forceFresh.ts` is this project's version of the same workaround.
 *
 * Set `EDGE_CACHE_TTL_MS=0` to take it out of the picture entirely.
 */
import type { RouteResponse } from "./httpError.js";

const TTL_MS = Number(process.env.EDGE_CACHE_TTL_MS ?? 10_000);

interface CacheEntry {
  readonly response: RouteResponse;
  readonly storedAt: number;
}

const entries = new Map<string, CacheEntry>();

const FRONTED = [/^\/api\/posts$/, /^\/api\/blogs\/[^/]+\/feed\.atom$/];

/**
 * Returns the cache key for a request the proxy fronts, or `undefined` when it passes straight
 * through. The key includes the query string, which is the whole reason a throwaway parameter
 * works as a bypass.
 */
export const edgeCacheKey = (method: string, path: string, search: string): string | undefined =>
  TTL_MS > 0 && method === "GET" && FRONTED.some((pattern) => pattern.test(path))
    ? `${method} ${path}${search}`
    : undefined;

/** Adds the proxy's own response fields; `age` is zero on a miss. */
const withEdgeHeaders = (response: RouteResponse, status: "HIT" | "MISS", ageMs: number): RouteResponse => ({
  ...response,
  headers: {
    ...response.headers,
    "x-cache": status,
    age: String(Math.floor(ageMs / 1000)),
    "cache-control": `public, max-age=${Math.floor(TTL_MS / 1000)}`,
  },
});

/** Serves a still-fresh entry, deliberately without consulting the request's own cache directives. */
export const edgeCacheLookup = (key: string): RouteResponse | undefined => {
  const entry = entries.get(key);
  if (entry === undefined) return undefined;
  const age = Date.now() - entry.storedAt;
  if (age > TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  return withEdgeHeaders(entry.response, "HIT", age);
};

/** Stores a successful response and returns it tagged as the miss that populated the cache. */
export const edgeCacheStore = (key: string, response: RouteResponse): RouteResponse => {
  if (response.status === 200) entries.set(key, { response, storedAt: Date.now() });
  return withEdgeHeaders(response, "MISS", 0);
};

/** Drops everything; used by the tests, and by the cache-refresh admin command. */
export const edgeCacheClear = (): void => entries.clear();
