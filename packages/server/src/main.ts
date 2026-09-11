import * as http from "node:http";
import { Effect, Layer } from "effect";
import * as routes from "./routes.js";
import { edgeCacheKey, edgeCacheLookup, edgeCacheStore } from "./edgeCache.js";
import { Store } from "./store.js";
import type { RouteResponse } from "./httpError.js";

const PORT = Number(process.env.PORT ?? 4000);
const MAX_BODY_BYTES = 6_000_000;

/**
 * Artificial per-route latency, off unless `RESPONSE_DELAY_MS` is set.
 *
 * This store answers in well under a millisecond, which makes request supersession impossible to
 * observe: two keystrokes typed milliseconds apart never actually overlap on the wire, so nothing
 * is ever there to cancel. Setting `RESPONSE_DELAY_MS=400` (optionally with `RESPONSE_DELAY_PATH`,
 * default `/api/admin/users`) makes the users directory's gate behaviour reproducible in a
 * browser instead of requiring an ad-hoc patch of this file.
 */
const RESPONSE_DELAY_MS = Number(process.env.RESPONSE_DELAY_MS ?? 0);
const RESPONSE_DELAY_PATH = process.env.RESPONSE_DELAY_PATH ?? "/api/admin/users";

const StoreLayer = Store.Default;
const runtime = Layer.toRuntime(StoreLayer).pipe(Effect.scoped, Effect.runSync);

const run = <E>(effect: Effect.Effect<RouteResponse, E, Store>): Promise<RouteResponse> =>
  Effect.runPromise(effect.pipe(Effect.provide(runtime)) as Effect.Effect<RouteResponse, E>);

const readRawBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const parseJsonBody = (raw: Buffer): unknown => {
  const text = raw.toString("utf8");
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __invalidJson: text };
  }
};

/** Node's own `http` module has no multipart parser; building a WHATWG `Request` from the raw
 * body and using its standard `.formData()` avoids reaching for a third-party dependency just for
 * this one legacy-shaped upload endpoint. */
const parseFormDataBody = (raw: Buffer, contentType: string): Promise<FormData> =>
  new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(raw),
  }).formData();

/**
 * How a route wants its request body. `text` and `urlEncoded` exist for the two legacy endpoints
 * whose callers never spoke JSON; in both cases this layer only turns bytes into the plainest
 * possible value and leaves every bit of validation to a schema in the handler.
 */
type BodyMode = "json" | "formData" | "text" | "urlEncoded" | "none";

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly bodyMode: BodyMode;
  readonly handle: (
    params: ReadonlyArray<string>,
    query: URLSearchParams,
    authHeader: string | undefined,
    body: unknown,
    accept: string | undefined,
  ) => Promise<RouteResponse>;
}

const routeTable: ReadonlyArray<Route> = [
  { method: "POST", pattern: /^\/api\/users$/, bodyMode: "json", handle: (_p, _q, _a, json) => run(routes.register(json)) },
  {
    method: "POST",
    pattern: /^\/api\/users\/login$/,
    bodyMode: "json",
    handle: (_p, _q, _a, json) => run(routes.login(json)),
  },
  {
    // The original mobile client posts `application/x-www-form-urlencoded`, not JSON.
    method: "POST",
    pattern: /^\/api\/users\/login\/legacy$/,
    bodyMode: "urlEncoded",
    handle: (_p, _q, _a, form) => run(routes.legacyLogin(form as Record<string, string>)),
  },
  { method: "GET", pattern: /^\/api\/user$/, bodyMode: "none", handle: (_p, _q, auth) => run(routes.currentUser(auth)) },
  {
    method: "GET",
    pattern: /^\/api\/blogs\/([^/]+)$/,
    bodyMode: "none",
    handle: ([username], _q, auth) => run(routes.getBlog(username!, auth)),
  },
  {
    method: "GET",
    pattern: /^\/api\/blogs\/([^/]+)\/feed\.atom$/,
    bodyMode: "none",
    handle: ([username]) => run(routes.getBlogFeed(username!)),
  },
  {
    // The importer's counterpart: the same Atom document, travelling the other way.
    method: "POST",
    pattern: /^\/api\/blogs\/([^/]+)\/import\.atom$/,
    bodyMode: "text",
    handle: ([username], _q, auth, xml) => run(routes.importAtom(username!, auth, xml as string)),
  },
  {
    method: "GET",
    pattern: /^\/api\/posts$/,
    bodyMode: "none",
    handle: (_p, query) => run(routes.listFeed(query.get("page") ?? undefined, query.get("limit") ?? undefined)),
  },
  {
    method: "POST",
    pattern: /^\/api\/posts$/,
    bodyMode: "json",
    handle: (_p, _q, auth, json) => run(routes.createPost(auth, json)),
  },
  {
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)$/,
    bodyMode: "none",
    handle: ([slug], _q, auth) => run(routes.getPost(slug!, auth)),
  },
  {
    method: "PUT",
    pattern: /^\/api\/posts\/([^/]+)$/,
    bodyMode: "json",
    handle: ([slug], _q, auth, json) => run(routes.updatePost(slug!, auth, json)),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/posts\/([^/]+)$/,
    bodyMode: "none",
    handle: ([slug], _q, auth) => run(routes.deletePost(slug!, auth)),
  },
  {
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)\/comments$/,
    bodyMode: "none",
    handle: ([slug], _q, auth) => run(routes.listComments(slug!, auth)),
  },
  {
    method: "POST",
    pattern: /^\/api\/posts\/([^/]+)\/comments$/,
    bodyMode: "json",
    handle: ([slug], _q, auth, json) => run(routes.createComment(slug!, auth, json)),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/posts\/([^/]+)\/comments\/([^/]+)$/,
    bodyMode: "none",
    handle: ([slug, commentId], _q, auth) => run(routes.deleteComment(slug!, commentId!, auth)),
  },
  {
    // JSON or Markdown at the same status, chosen by `Accept`.
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)\/export$/,
    bodyMode: "none",
    handle: ([slug], _q, auth, _body, accept) => run(routes.exportPost(slug!, auth, accept)),
  },
  {
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)\/attachments$/,
    bodyMode: "none",
    handle: ([slug], _q, auth) => run(routes.listAttachments(slug!, auth)),
  },
  {
    method: "POST",
    pattern: /^\/api\/posts\/([^/]+)\/attachments$/,
    bodyMode: "formData",
    handle: ([slug], _q, auth, formData) => run(routes.uploadAttachment(slug!, auth, formData as FormData)),
  },
  {
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)\/attachments\/([^/]+)$/,
    bodyMode: "none",
    handle: ([slug, attachmentId], _q, auth) => run(routes.getAttachmentBytes(slug!, attachmentId!, auth)),
  },
  {
    // Metadata and bytes in one multipart response.
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)\/attachments\/([^/]+)\/bundle$/,
    bodyMode: "none",
    handle: ([slug, attachmentId], _q, auth) => run(routes.attachmentBundle(slug!, attachmentId!, auth)),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/posts\/([^/]+)\/attachments\/([^/]+)$/,
    bodyMode: "none",
    handle: ([slug, attachmentId], _q, auth) => run(routes.deleteAttachment(slug!, attachmentId!, auth)),
  },
  {
    method: "GET",
    pattern: /^\/api\/admin\/users$/,
    bodyMode: "none",
    handle: (_p, query, auth) =>
      run(routes.adminListUsers(auth, query.get("name") ?? undefined, query.get("email") ?? undefined)),
  },
  {
    method: "GET",
    pattern: /^\/api\/admin\/stats$/,
    bodyMode: "none",
    handle: (_p, _q, auth) => run(routes.adminStats(auth)),
  },
  {
    method: "POST",
    pattern: /^\/api\/admin\/cache\/refresh$/,
    bodyMode: "json",
    handle: (_p, _q, auth, json) => run(routes.adminRefreshCache(auth, json)),
  },
  {
    // Answers 503 + Retry-After until the warm-standby search cluster is up.
    method: "POST",
    pattern: /^\/api\/admin\/search\/reindex$/,
    bodyMode: "none",
    handle: (_p, _q, auth) => run(routes.adminReindex(auth)),
  },
  {
    // JSON from the modern subsystem, or the old watchdog's plain-text dump when it is unhealthy.
    method: "GET",
    pattern: /^\/api\/admin\/diagnostics$/,
    bodyMode: "none",
    handle: (_p, query, auth) => run(routes.adminDiagnostics(auth, query.get("degraded") === "1")),
  },
];

const baseCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const server = http.createServer((req, res) => {
  const start = Date.now();
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Effect Platform's `FetchHttpClient` propagates tracing context via `traceparent` *and* `b3`
  // request headers by default, which triggers a CORS preflight most fixed allow-lists don't
  // expect. Reflecting `Access-Control-Request-Headers` (a common permissive dev-server pattern)
  // instead of hard-coding a list avoids that surprise; the library's README now documents both
  // header names and the `HttpClient.withTracerPropagation(false)` opt-out under "Browsers and
  // CORS".
  const requestedHeaders = req.headers["access-control-request-headers"];
  const CORS_HEADERS = {
    ...baseCorsHeaders,
    "access-control-allow-headers": requestedHeaders ?? "content-type, authorization",
  };

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const route = routeTable.find((candidate) => candidate.method === method && candidate.pattern.test(url.pathname));

  const write = (response: RouteResponse) => {
    // A handler may add fields of its own, such as the `Retry-After` the reindex route sends with
    // its warm-up `503`; they have to be exposed to a cross-origin caller to be readable at all.
    const extra = response.headers ?? {};
    const exposed =
      Object.keys(extra).length === 0 ? {} : { "access-control-expose-headers": Object.keys(extra).join(", ") };
    const headers = { ...CORS_HEADERS, ...exposed, ...extra };

    if (response.kind === "empty") {
      res.writeHead(response.status, headers);
      res.end();
    } else if (response.kind === "json") {
      const payload = response.body === undefined ? "" : JSON.stringify(response.body);
      res.writeHead(response.status, { ...headers, "content-type": "application/json" });
      res.end(payload);
    } else {
      // "text" and "bytes" both write their body as-is; Node's `res.end` accepts a string or a
      // Buffer/Uint8Array either way.
      res.writeHead(response.status, { ...headers, "content-type": response.contentType });
      res.end(response.body);
    }
    console.log(`${method} ${url.pathname} -> ${response.status} (${Date.now() - start}ms)`);
  };

  // The reverse proxy in front of this API (see edgeCache.ts) fronts exactly two routes.
  const cacheKey = edgeCacheKey(method, url.pathname, url.search);

  const delayed = RESPONSE_DELAY_MS > 0 && url.pathname.startsWith(RESPONSE_DELAY_PATH);
  const respond = (rawResponse: RouteResponse) => {
    const response = cacheKey === undefined ? rawResponse : edgeCacheStore(cacheKey, rawResponse);
    if (!delayed) {
      write(response);
      return;
    }
    // A client that gave up — an interrupted fetch, i.e. a real `AbortController.abort()` — has
    // already closed this socket; writing to it would throw rather than prove anything.
    const timer = setTimeout(() => {
      if (!res.writableEnded) write(response);
    }, RESPONSE_DELAY_MS);
    res.on("close", () => clearTimeout(timer));
  };

  if (!route) {
    respond({ kind: "json", status: 404, body: { _tag: "NotFoundError", resource: "Route", id: url.pathname } });
    return;
  }

  if (cacheKey !== undefined) {
    const cached = edgeCacheLookup(cacheKey);
    if (cached !== undefined) {
      // Deliberately not consulting `req.headers["cache-control"]`: this proxy never learned to.
      write(cached);
      return;
    }
  }

  const params = route.pattern.exec(url.pathname)?.slice(1) ?? [];
  const authHeader = req.headers.authorization;

  const parseBody = (raw: Buffer): unknown | Promise<unknown> => {
    switch (route.bodyMode) {
      case "formData":
        return parseFormDataBody(raw, req.headers["content-type"] ?? "");
      case "text":
        return raw.toString("utf8");
      case "urlEncoded":
        return Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
      default:
        return parseJsonBody(raw);
    }
  };

  const bodyPromise: Promise<unknown> =
    route.bodyMode === "none" ? Promise.resolve(undefined) : readRawBody(req).then(parseBody);

  bodyPromise
    .then((body) => route.handle(params, url.searchParams, authHeader, body, req.headers.accept))
    .then(respond)
    .catch((error: unknown) => {
      console.error("unhandled server error", error);
      respond({ kind: "json", status: 500, body: { message: "internal server error" } });
    });
});

server.listen(PORT, () => {
  console.log(`realworld demo server listening on http://localhost:${PORT}`);
});
