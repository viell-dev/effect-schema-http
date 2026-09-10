import * as http from "node:http";
import { Effect, Layer } from "effect";
import * as routes from "./routes.js";
import { Store } from "./store.js";
import type { JsonResponse } from "./httpError.js";

const PORT = Number(process.env.PORT ?? 4000);
const MAX_BODY_BYTES = 1_000_000;

const StoreLayer = Store.Default;
const runtime = Layer.toRuntime(StoreLayer).pipe(Effect.scoped, Effect.runSync);

const run = <E>(effect: Effect.Effect<JsonResponse, E, Store>): Promise<JsonResponse> =>
  Effect.runPromise(effect.pipe(Effect.provide(runtime)) as Effect.Effect<JsonResponse, E>);

const readJsonBody = (req: http.IncomingMessage): Promise<unknown> =>
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
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ __invalidJson: raw });
      }
    });
    req.on("error", reject);
  });

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handle: (
    params: ReadonlyArray<string>,
    query: URLSearchParams,
    authHeader: string | undefined,
    json: unknown,
  ) => Promise<JsonResponse>;
}

const routeTable: ReadonlyArray<Route> = [
  { method: "POST", pattern: /^\/api\/users$/, handle: (_p, _q, _a, json) => run(routes.register(json)) },
  { method: "POST", pattern: /^\/api\/users\/login$/, handle: (_p, _q, _a, json) => run(routes.login(json)) },
  { method: "GET", pattern: /^\/api\/user$/, handle: (_p, _q, auth) => run(routes.currentUser(auth)) },
  {
    method: "GET",
    pattern: /^\/api\/blogs\/([^/]+)$/,
    handle: ([username], _q, auth) => run(routes.getBlog(username!, auth)),
  },
  {
    method: "GET",
    pattern: /^\/api\/posts$/,
    handle: (_p, query) => run(routes.listFeed(query.get("page") ?? undefined, query.get("limit") ?? undefined)),
  },
  { method: "POST", pattern: /^\/api\/posts$/, handle: (_p, _q, auth, json) => run(routes.createPost(auth, json)) },
  {
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)$/,
    handle: ([slug], _q, auth) => run(routes.getPost(slug!, auth)),
  },
  {
    method: "PUT",
    pattern: /^\/api\/posts\/([^/]+)$/,
    handle: ([slug], _q, auth, json) => run(routes.updatePost(slug!, auth, json)),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/posts\/([^/]+)$/,
    handle: ([slug], _q, auth) => run(routes.deletePost(slug!, auth)),
  },
  {
    method: "GET",
    pattern: /^\/api\/posts\/([^/]+)\/comments$/,
    handle: ([slug], _q, auth) => run(routes.listComments(slug!, auth)),
  },
  {
    method: "POST",
    pattern: /^\/api\/posts\/([^/]+)\/comments$/,
    handle: ([slug], _q, auth, json) => run(routes.createComment(slug!, auth, json)),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/posts\/([^/]+)\/comments\/([^/]+)$/,
    handle: ([slug, commentId], _q, auth) => run(routes.deleteComment(slug!, commentId!, auth)),
  },
];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const server = http.createServer((req, res) => {
  const start = Date.now();
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const route = routeTable.find((candidate) => candidate.method === method && candidate.pattern.test(url.pathname));

  const respond = (status: number, body: unknown) => {
    const payload = body === null || body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" });
    res.end(payload);
    console.log(`${method} ${url.pathname} -> ${status} (${Date.now() - start}ms)`);
  };

  if (!route) {
    respond(404, { _tag: "NotFoundError", resource: "Route", id: url.pathname });
    return;
  }

  const params = route.pattern.exec(url.pathname)?.slice(1) ?? [];
  const authHeader = req.headers.authorization;
  const needsBody = method === "POST" || method === "PUT";

  (needsBody ? readJsonBody(req) : Promise.resolve(undefined))
    .then((json) => route.handle(params, url.searchParams, authHeader, json))
    .then(({ status, body }) => respond(status, body))
    .catch((error: unknown) => {
      console.error("unhandled server error", error);
      respond(500, { message: "internal server error" });
    });
});

server.listen(PORT, () => {
  console.log(`realworld demo server listening on http://localhost:${PORT}`);
});
