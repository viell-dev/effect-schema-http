import { Schema } from "effect";
import { response, ResponseBody } from "viell-effect-schema-http";
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
import { apiServer } from "./apiClient.js";

/**
 * The Java service's older endpoints.
 *
 * They share `apiServer`'s declaration — the `Token` authentication scheme and the two
 * error shapes — and differ in almost everything else.
 */

/**
 * `GET /api/odata/Orders` — read as **text**, not JSON.
 *
 * This is the one endpoint in the whole client that cannot use the default codec, and
 * the reason is worth stating precisely: the payload contains 64-bit ids above 2^53, and
 * `JSON.parse` rounds them. A schema applied after parsing cannot recover the digits,
 * because they are already gone. Reading the body as text and composing a different JSON
 * parser underneath the real schema is the only correct answer, and the library needs
 * nothing added to allow it — `ResponseBody.text` plus a `*FromString` schema is exactly
 * the case its documentation describes for "a custom JSON dialect".
 */
export const listOrders = apiServer.createRequest({
  method: "GET",
  path: "/api/odata/Orders",
  responses: [
    response({ _tag: "ok", status: 200 }, losslessJsonOf(OrderPage), { codec: ResponseBody.text }),
  ],
});

/**
 * `GET /api/reports/grid` — column-oriented rows behind an unregistered content type.
 *
 * The header matcher is load-bearing rather than decorative: the reporting gateway
 * answers `text/json` when it serves the grid and `application/json` when it serves an
 * error it forgot to give a status to, so the content type is what distinguishes them.
 */
export const gridReport = apiServer.createRequest({
  method: "GET",
  path: "/api/reports/grid",
  responses: [
    response(
      {
        _tag: "ok",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("text/json") ?? false },
      },
      GridReport,
    ),
  ],
});

/**
 * `GET /api/v2/projects/:id` — the one endpoint on this service that behaves correctly.
 *
 * A `304` is a mapped response with no body, which is exactly what `ResponseBody.none`
 * and `Schema.Void` describe. Nothing about it is an error, and modelling it as one
 * would be the mistake.
 */
export const getVersionedProject = apiServer.createRequest({
  method: "GET",
  path: "/api/v2/projects/:id",
  responses: [
    response({ _tag: "ok", status: 200 }, ProjectRecord),
    response({ _tag: "notModified", status: 304 }, Schema.Void, { codec: ResponseBody.none }),
  ],
});

/**
 * The same resource, written.
 *
 * Declared as `PUT` so the call site reads honestly; `tunnelMethod("PUT")` rewrites the
 * dispatched method to `POST` and adds the override header the gateway expects. Without
 * that transform the request is refused with `405` — which is a declared rule here, so a
 * caller that forgets gets a typed value explaining exactly what to do rather than an
 * unhandled response.
 */
export const putVersionedProject = apiServer.createRequest({
  method: "PUT",
  path: "/api/v2/projects/:id",
  body: Schema.Struct({ name: Schema.optional(Schema.String), description: Schema.optional(Schema.String) }),
  responses: [
    response({ _tag: "ok", status: 200 }, ProjectRecord),
    response({ _tag: "preconditionFailed", status: 412 }, Schema.Unknown),
    response({ _tag: "preconditionRequired", status: 428 }, Schema.Unknown),
    response({ _tag: "methodBlocked", status: 405 }, Schema.Unknown),
  ],
});

/**
 * `POST /api/batch` — one `200` carrying several outcomes.
 *
 * The envelope says nothing about whether the individual calls worked, so the rule list
 * is a single `200` and all the discrimination happens in the schema. That is the
 * library's stated division of labour, and this endpoint is the case where it is
 * forced rather than chosen.
 */
export const batchGet = apiServer.createRequest({
  method: "POST",
  path: "/api/batch",
  body: BatchRequest,
  responses: [response({ _tag: "ok", status: 200 }, BatchResponse)],
});

/** `POST /api/imports` — 202 with a relative `Location` the caller has to resolve. */
export const startImport = apiServer.createRequest({
  method: "POST",
  path: "/api/imports",
  body: Schema.Struct({ source: Schema.String }),
  responses: [response({ _tag: "accepted", status: 202 }, ImportAccepted)],
});

/** `GET /api/imports/:id` — pending twice, then done. */
export const importStatus = apiServer.createRequest({
  method: "GET",
  path: "/api/imports/:id",
  responses: [response({ _tag: "ok", status: 200 }, ImportStatus)],
});

/**
 * `GET /api/lookup` — where failure is a header, not a status.
 *
 * Two rules at `200`, separated only by `x-error-code`. The header-bearing rule is more
 * specific and is therefore tried first, so the same call site renders matches or a
 * syntax error without either rule having to know about the other. This is the case that
 * shows why rules match on the envelope rather than on the body: the fact that decides
 * which shape arrived is in the headers, and it is available before a single byte of the
 * payload has been read.
 */
export const lookup = apiServer.createRequest({
  method: "GET",
  path: "/api/lookup",
  responses: [
    response(
      {
        _tag: "LookupSyntaxError",
        status: 200,
        headers: { "x-error-code": (value) => value !== undefined },
      },
      LookupSyntaxError,
    ),
    response({ _tag: "ok", status: 200 }, LookupMatches),
  ],
});

/** `GET /api/projects` with the paginated contract, whose `Link` header is 0-based. */
export const listProjectsPage = apiServer.createRequest({
  method: "GET",
  path: "/api/projects",
  responses: [response({ _tag: "ok", status: 200 }, Schema.Array(ProjectRecord))],
});
