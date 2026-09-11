import { Schema } from "effect";
import {
  createApi,
  response,
  ResponseBody,
} from "viell-effect-schema-http";
import {
  Comment,
  CreateCommentInput,
  CreateProjectInput,
  CreateTaskInput,
  FileProxyUploadInput,
  FileProxyUploadResponse,
  FlatError,
  PatchProjectInput,
  PatchTaskInput,
  Project,
  SearchResults,
  StructuredError,
  Task,
} from "../schemas/apiServer.js";
import { getSession } from "../session.js";

export const API_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_SERVER_URL) ||
  "http://localhost:4300";

/**
 * API Server client.
 *
 * Quirks:
 * 1. Authorization header MUST use 'Token <value>', NOT 'Bearer <value>'.
 * 2. 4xx errors use StructuredError { error: { code, message } }.
 * 3. 5xx errors use FlatError { error: string }.
 */
export const apiServer = createApi(API_SERVER_URL, {
  headers: {
    authorization: () => {
      const session = getSession();
      // Quirk: "Token" scheme, not "Bearer"
      return session ? `Token ${session.accessToken}` : undefined;
    },
  },
  responses: [
    response(
      {
        _tag: "StructuredError",
        status: (s: number) => s >= 400 && s < 500,
      },
      StructuredError,
    ),
    response({ _tag: "FlatError", status: 500 }, FlatError),
  ] as const,
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const listProjects = apiServer.createRequest({
  method: "GET",
  path: "/api/projects",
  responses: [response({ _tag: "ok", status: 200 }, Schema.Array(Project))],
});

export const getProject = apiServer.createRequest({
  method: "GET",
  path: "/api/projects/:id",
  responses: [response({ _tag: "ok", status: 200 }, Project)],
});

export const createProject = apiServer.createRequest({
  method: "POST",
  path: "/api/projects",
  body: CreateProjectInput,
  responses: [response({ _tag: "created", status: 201 }, Project)],
});

/**
 * Quirk: PATCH returns the OLD state of the project, not the updated state!
 */
export const patchProject = apiServer.createRequest({
  method: "PATCH",
  path: "/api/projects/:id",
  body: PatchProjectInput,
  responses: [response({ _tag: "ok", status: 200 }, Project)],
});

/**
 * `DELETE /api/projects/:id`.
 *
 * The handler still writes `{"deleted": true}` after its `204`, a debug aid added in
 * 2015. It has never reached a client: the container refuses to write a payload for a
 * status that forbids one. Declaring `ResponseBody.json` here produces a decode failure
 * on every successful delete, which is how that was discovered — the JSON codec rejects
 * an empty payload, correctly. `ResponseBody.none` describes what actually arrives.
 */
export const deleteProject = apiServer.createRequest({
  method: "DELETE",
  path: "/api/projects/:id",
  responses: [response({ _tag: "noContent", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const listTasksRequest = apiServer.createRequest({
  method: "GET",
  path: "/api/tasks",
  responses: [response({ _tag: "ok", status: 200 }, Schema.Array(Task))],
});

export const listTasks = (projectId: string) =>
  listTasksRequest().setUrlParam("projectId", projectId);

export const getTask = apiServer.createRequest({
  method: "GET",
  path: "/api/tasks/:id",
  responses: [response({ _tag: "ok", status: 200 }, Task)],
});

/**
 * Quirk: Request accepts status as string name ("OPEN", "IN_PROGRESS", ...),
 * while responses return status as integer ordinal (0, 1, ...).
 */
export const createTask = apiServer.createRequest({
  method: "POST",
  path: "/api/tasks",
  body: CreateTaskInput,
  responses: [response({ _tag: "created", status: 201 }, Task)],
});

export const patchTask = apiServer.createRequest({
  method: "PATCH",
  path: "/api/tasks/:id",
  body: PatchTaskInput,
  responses: [response({ _tag: "ok", status: 200 }, Task)],
});

/**
 * `DELETE /api/tasks/:id` — refused unless it is tunnelled.
 *
 * The gateway in front of this service strips `DELETE`, so the service refuses a raw one
 * too. Apply `tunnelMethod("DELETE")` at the call site.
 */
export const deleteTask = apiServer.createRequest({
  method: "DELETE",
  path: "/api/tasks/:id",
  responses: [
    response({ _tag: "noContent", status: 204 }, Schema.Void, { codec: ResponseBody.none }),
    response({ _tag: "methodBlocked", status: 405 }, StructuredError),
  ],
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const listCommentsRequest = apiServer.createRequest({
  method: "GET",
  path: "/api/comments",
  responses: [response({ _tag: "ok", status: 200 }, Schema.Array(Comment))],
});

export const listComments = (taskId: string) =>
  listCommentsRequest().setUrlParam("taskId", taskId);

/**
 * Quirk 1: Returns 200 OK (not 201 Created).
 * Quirk 2: Location response header is relative ("/api/comments/:id"), not absolute.
 */
export const createComment = apiServer.createRequest({
  method: "POST",
  path: "/api/comments",
  body: CreateCommentInput,
  responses: [response({ _tag: "ok", status: 200 }, Comment)],
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const searchRequest = apiServer.createRequest({
  method: "GET",
  path: "/api/search",
  responses: [response({ _tag: "ok", status: 200 }, SearchResults)],
});

/**
 * Quirk: Returns bare object when exactly 1 match, array when multiple.
 * SearchResults schema transform normalizes both to Array<SearchHit>.
 */
export const search = (q: string, page?: number, pageSize?: number) => {
  let plan = searchRequest().setUrlParam("q", q);
  if (page !== undefined) plan = plan.setUrlParam("page", String(page));
  if (pageSize !== undefined) plan = plan.setUrlParam("pageSize", String(pageSize));
  return plan;
};

// ---------------------------------------------------------------------------
// File Proxy
// ---------------------------------------------------------------------------

export const uploadFileProxy = apiServer.createRequest({
  method: "POST",
  path: "/api/files",
  body: FileProxyUploadInput,
  responses: [response({ _tag: "ok", status: 200 }, FileProxyUploadResponse)],
});

export const downloadFileProxy = apiServer.createRequest({
  method: "GET",
  path: "/api/files/:id",
  responses: [
    response({ _tag: "ok", status: 200 }, Schema.Uint8ArrayFromSelf, {
      codec: ResponseBody.uint8Array,
    }),
  ],
});
