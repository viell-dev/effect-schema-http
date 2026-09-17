import { HttpClient } from "@effect/platform";
import { Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import {
  BatchRequest,
  BatchResponse,
  GridReport,
  ImportAccepted,
  ImportStatus,
  LookupMatches,
  LookupSyntaxError,
  losslessJsonOf,
  OrderPage,
  ProjectRecord,
} from "../schemas/apiLegacy.js";
import { apiFailure, apiRequest } from "./apiClient.js";
import { configure, executionOptions, type Options } from "./options.js";

/** GET /api/odata/Orders. */
export const listOrders = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/odata/Orders", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.text.pipe(Body.schema(losslessJsonOf(OrderPage)), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/reports/grid. */
export const gridReport = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/reports/grid", {}).pipe(configure(options)),
    Response.when(
      (metadata) =>
        metadata.status === 200 &&
        ((value) => value?.startsWith("text/json") ?? false)(metadata.headers["content-type"]),
      Body.json.pipe(Body.schema(GridReport), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/v2/projects/:id. */
export const getVersionedProject = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/v2/projects/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/v2/projects/${encode(value.id)}`),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(ProjectRecord), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          304,
          Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("notModified", decoder)),
        ),
      ),
      Response.orElse(apiFailure),
    ),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** PUT /api/v2/projects/:id. */
export const putVersionedProject = (options: Options = {}) =>
  Operation.make(
    apiRequest("PUT", "/api/v2/projects/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/v2/projects/${encode(value.id)}`),
      Request.body(
        Body.jsonSchema(
          Schema.Struct({ name: Schema.optional(Schema.String), description: Schema.optional(Schema.String) }),
        ),
      ),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(ProjectRecord), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          412,
          Body.json.pipe(Body.schema(Schema.Unknown), (decoder) => Response.tag("preconditionFailed", decoder)),
        ),
      ),
      Response.orElse(
        Response.status(
          428,
          Body.json.pipe(Body.schema(Schema.Unknown), (decoder) => Response.tag("preconditionRequired", decoder)),
        ),
      ),
      Response.orElse(
        Response.status(
          405,
          Body.json.pipe(Body.schema(Schema.Unknown), (decoder) => Response.tag("methodBlocked", decoder)),
        ),
      ),
      Response.orElse(apiFailure),
    ),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** POST /api/batch. */
export const batchGet = (options: Options = {}) =>
  Operation.make(
    apiRequest("POST", "/api/batch", {}).pipe(configure(options), Request.body(Body.jsonSchema(BatchRequest))),
    Response.status(
      200,
      Body.json.pipe(Body.schema(BatchResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** POST /api/imports. */
export const startImport = (options: Options = {}) =>
  Operation.make(
    apiRequest("POST", "/api/imports", {}).pipe(
      configure(options),
      Request.body(Body.jsonSchema(Schema.Struct({ source: Schema.String }))),
    ),
    Response.status(
      202,
      Body.json.pipe(Body.schema(ImportAccepted), (decoder) => Response.tag("accepted", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/imports/:id. */
export const importStatus = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/imports/:id", {}).pipe(
      configure(options),
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/imports/${encode(value.id)}`),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(ImportStatus), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/lookup. */
export const lookup = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/lookup", {}).pipe(configure(options)),
    Response.when(
      (metadata) => metadata.status === 200 && ((value) => value !== undefined)(metadata.headers["x-error-code"]),
      Body.json.pipe(Body.schema(LookupSyntaxError), (decoder) => Response.tag("LookupSyntaxError", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          200,
          Body.json.pipe(Body.schema(LookupMatches), (decoder) => Response.tag("ok", decoder)),
        ),
      ),
      Response.orElse(apiFailure),
    ),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );

/** GET /api/projects. */
export const listProjectsPage = (options: Options = {}) =>
  Operation.make(
    apiRequest("GET", "/api/projects", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Schema.Array(ProjectRecord)), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(apiFailure)),
    executionOptions(options, HttpClient.withTracerPropagation(false)),
  );
