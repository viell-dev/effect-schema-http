import { HttpClient } from "@effect/platform";
import { Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
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
import { configure, executionOptions, type Options } from "./options.js";
export const API_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_SERVER_URL) || "http://localhost:4300";

export const apiRequest = (method: string, path: string, options: Options) =>
  Request.make(method, path).pipe(
    Request.baseUrl(API_SERVER_URL),
    Request.setHeader("authorization", () => {
      const session = getSession();
      // Quirk: "Token" scheme, not "Bearer"
      return session ? `Token ${session.accessToken}` : undefined;
    }),
    configure(options),
  );

export const apiFailure = Response.when(
  (metadata) => ((s: number) => s >= 400 && s < 500)(metadata.status),
  Body.json.pipe(Body.schema(StructuredError), (decoder) => Response.tag("StructuredError", decoder)),
).pipe(
  Response.orElse(
    Response.status(
      500,
      Body.json.pipe(Body.schema(FlatError), (decoder) => Response.tag("FlatError", decoder)),
    ),
  ),
);

/** GET /api/projects. */
export const listProjects = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/projects", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Schema.Array(Project)), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/projects/:id. */
export const getProject = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/projects/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/projects/${encode(value.id)}`),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Project), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** POST /api/projects. */
export const createProject = (options: Options = {}) =>
  Operation.make(
    apiRequest("POST", "/api/projects", {}).pipe(configure(options), Request.body(Body.jsonSchema(CreateProjectInput))),
    Response.status(
      201,
      Body.json.pipe(Body.schema(Project), (decoder) => Response.tag("created", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** PATCH /api/projects/:id. */
export const patchProject = (options: Options = {}) =>
  Operation.make(
    apiRequest("PATCH", "/api/projects/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/projects/${encode(value.id)}`),
      Request.body(Body.jsonSchema(PatchProjectInput)),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Project), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** DELETE /api/projects/:id. */
export const deleteProject = (options: Options = {}) =>
  Operation.make(
    apiRequest("DELETE", "/api/projects/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/projects/${encode(value.id)}`),
    ),
    Response.status(
      204,
      Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("noContent", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/tasks. */
export const listTasksRequest = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/tasks", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Schema.Array(Task)), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/tasks/:id. */
export const getTask = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/tasks/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/tasks/${encode(value.id)}`),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Task), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** POST /api/tasks. */
export const createTask = (options: Options = {}) =>
  Operation.make(
    apiRequest("POST", "/api/tasks", {}).pipe(configure(options), Request.body(Body.jsonSchema(CreateTaskInput))),
    Response.status(
      201,
      Body.json.pipe(Body.schema(Task), (decoder) => Response.tag("created", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** PATCH /api/tasks/:id. */
export const patchTask = (options: Options = {}) =>
  Operation.make(
    apiRequest("PATCH", "/api/tasks/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/tasks/${encode(value.id)}`),
      Request.body(Body.jsonSchema(PatchTaskInput)),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Task), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** DELETE /api/tasks/:id. */
export const deleteTask = (options: Options = {}) =>
  Operation.make(
    apiRequest("DELETE", "/api/tasks/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/tasks/${encode(value.id)}`),
    ),
    Response.status(
      204,
      Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("noContent", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          405,
          Body.json.pipe(Body.schema(StructuredError), (decoder) => Response.tag("methodBlocked", decoder)),
        ),
      ),
      Response.orElse(apiFailure),
    ),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/comments. */
export const listCommentsRequest = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/comments", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Schema.Array(Comment)), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** POST /api/comments. */
export const createComment = (options: Options = {}) =>
  Operation.make(
    apiRequest("POST", "/api/comments", {}).pipe(configure(options), Request.body(Body.jsonSchema(CreateCommentInput))),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Comment), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/search. */
export const searchRequest = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/search", {}).pipe(
      configure(options),
      Request.query(
        Schema.Struct({
          q: Schema.String,
          page: Schema.optional(Schema.NumberFromString),
          pageSize: Schema.optional(Schema.NumberFromString),
        }),
      ),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(SearchResults), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** POST /api/files. */
export const uploadFileProxy = (options: Options = {}) =>
  Operation.make(
    apiRequest("POST", "/api/files", {}).pipe(configure(options), Request.body(Body.jsonSchema(FileProxyUploadInput))),
    Response.status(
      200,
      Body.json.pipe(Body.schema(FileProxyUploadResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/files/:id. */
export const downloadFileProxy = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/files/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/files/${encode(value.id)}`),
    ),
    Response.status(
      200,
      Body.bytes.pipe(Body.schema(Schema.Uint8ArrayFromSelf), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

export const listTasks = (projectId: string) =>
  listTasksRequest({ request: Request.setQuery("projectId", projectId) }).execute(undefined);
export const listComments = (taskId: string) =>
  listCommentsRequest({ request: Request.setQuery("taskId", taskId) }).execute(undefined);
export const search = (q: string, page?: number, pageSize?: number) =>
  searchRequest().execute({
    query: { q, ...(page === undefined ? {} : { page }), ...(pageSize === undefined ? {} : { pageSize }) },
  });
