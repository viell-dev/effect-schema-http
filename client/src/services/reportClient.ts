import { Schema } from "effect";
import { createApi, RequestBody, response, ResponseBody } from "viell-effect-schema-http";
import {
  AdminSummaryLine,
  ExcelCsv,
  FixedWidthExtract,
  GatewayErrorLine,
  LoginLine,
  methodCall,
  ReportTask,
  RpcExtract,
  rpcResult,
} from "../schemas/reportGateway.js";
import { getReportSession } from "../session.js";

export const REPORT_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_REPORT_SERVER_URL) || "http://localhost:4400";

/**
 * The 1999 reporting gateway.
 *
 * It has no idea the other four services exist. Its credential is a session id it hands
 * out in a query string and expects back in a query string, and it answers `200` to
 * everything — so the API-wide declaration here is one computed query parameter, and
 * every endpoint's failure handling is either a header-matched rule or a union in the
 * schema.
 */
export const reportApi = createApi(REPORT_SERVER_URL, {
  urlParams: {
    // Computed, so a plan built before signing in still sends the current session, and
    // sends nothing at all when there is none.
    session: () => getReportSession(),
  },
});

/**
 * `GET /cgi-bin/login.pl?user=&pass=` — credentials in a query string.
 *
 * This is not a mistake in the test: it is what the endpoint is, and it is still called
 * by two entries in a crontab. The password ends up in the access log, in the proxy log,
 * and in the referrer of the page that follows.
 *
 * `removeUrlParams` takes away the API-wide session parameter, because logging in is
 * the one call that cannot have one yet.
 */
export const reportLogin = reportApi.createRequest({
  method: "GET",
  path: "/cgi-bin/login.pl",
  removeUrlParams: ["session"],
  responses: [response({ _tag: "ok", status: 200 }, LoginLine, { codec: ResponseBody.text })],
});

/**
 * `POST /cgi-bin/rpc.pl` — XML-RPC, 1998 vintage.
 *
 * The body is an XML document built by hand and sent through `RequestBody.text`; the
 * response is read through `rpcResult`, which turns a `<fault>` into a tagged union
 * member instead of a decode failure. Both directions are ordinary schemas — there is
 * nothing XML-RPC-shaped anywhere in the library.
 */
const rpcCall = reportApi.createRequest({
  method: "POST",
  path: "/cgi-bin/rpc.pl",
  body: Schema.String,
  bodyCodec: RequestBody.text("text/xml"),
  // XML-RPC carries its own parameters; the API-wide session parameter would be
  // ignored, and sending a credential in a URL twice is once too many.
  removeUrlParams: ["session"],
  responses: [response({ _tag: "ok", status: 200 }, Schema.String, { codec: ResponseBody.text })],
});

/** `report.list` — an array of structs, each with six differently-typed members. */
export const rpcListTasks = (session: string) =>
  rpcCall()
    .setBody(methodCall("report.list", [session]))
    .setResponseSchema({ _tag: "ok", status: 200 }, rpcResult(Schema.Array(ReportTask)), {
      codec: ResponseBody.text,
    });

/** `report.count` — a bare `<i4>`, which is a complete XML-RPC response on its own. */
export const rpcCountTasks = (session: string) =>
  rpcCall()
    .setBody(methodCall("report.count", [session]))
    .setResponseSchema({ _tag: "ok", status: 200 }, rpcResult(Schema.Number), { codec: ResponseBody.text });

/** `report.fetch` — the fixed-width extract, base64 inside the XML-RPC response. */
export const rpcFetchExtract = (session: string, name: string) =>
  rpcCall()
    .setBody(methodCall("report.fetch", [session, name]))
    .setResponseSchema({ _tag: "ok", status: 200 }, rpcResult(RpcExtract), { codec: ResponseBody.text });

/** An unknown method, which answers `-32601` inside a `200`. */
export const rpcUnknownMethod = (session: string) =>
  rpcCall()
    .setBody(methodCall("report.doesNotExist", [session]))
    .setResponseSchema({ _tag: "ok", status: 200 }, rpcResult(Schema.Unknown), { codec: ResponseBody.text });

/**
 * `GET /cgi-bin/admin.pl` — behind HTTP Digest authentication, 1997 edition.
 *
 * Both outcomes are declared, because both are ordinary: the `401` carries the challenge
 * the client needs in order to build its answer, and it is a *value* here rather than an
 * error. That is what makes the two-round-trip flow ten lines of plain code — read the
 * challenge off the first response, set one header, execute the same cold plan again.
 */
export const adminSummary = reportApi.createRequest({
  method: "GET",
  path: "/cgi-bin/admin.pl",
  removeUrlParams: ["session"],
  responses: [
    response({ _tag: "challenge", status: 401 }, GatewayErrorLine, { codec: ResponseBody.text }),
    response({ _tag: "ok", status: 200 }, AdminSummaryLine, { codec: ResponseBody.text }),
  ],
});

/**
 * `GET /cgi-bin/report.pl` — the fixed-width extract, over HTTP this time.
 *
 * Two rules at `200`, separated by `X-Error-Code`. The header-bearing rule is more
 * specific and is tried first, which is what lets a service that answers `200` to
 * everything still be handled exhaustively: the error is in the envelope, just not in
 * the status line.
 *
 * The success rule reads **bytes**. The records are Latin-1 with no delimiters and a
 * trailer that has to reconcile, so the schema needs the bytes rather than a string
 * some decoder has already guessed at.
 */
export const fetchExtract = reportApi.createRequest({
  method: "GET",
  path: "/cgi-bin/report.pl",
  urlParams: { rpt: "TASKS" },
  responses: [
    response(
      { _tag: "GatewayError", status: 200, headers: { "x-error-code": (value) => value !== undefined } },
      GatewayErrorLine,
      { codec: ResponseBody.text },
    ),
    response({ _tag: "ok", status: 200 }, FixedWidthExtract, { codec: ResponseBody.uint8Array }),
  ],
});

/**
 * `GET /cgi-bin/export.pl` — the spreadsheet export.
 *
 * A UTF-8 byte order mark, CRLF, semicolons and a decimal comma, served as
 * `application/octet-stream` because in 2004 that was how you made a browser download a
 * file. Bytes again, and for the BOM this time: read as text it survives as `U+FEFF`
 * inside the first column name and every lookup by header silently misses.
 */
export const exportCsv = reportApi.createRequest({
  method: "GET",
  path: "/cgi-bin/export.pl",
  urlParams: { rpt: "TASKS" },
  responses: [
    response(
      { _tag: "GatewayError", status: 200, headers: { "x-error-code": (value) => value !== undefined } },
      GatewayErrorLine,
      { codec: ResponseBody.text },
    ),
    response({ _tag: "ok", status: 200 }, ExcelCsv, { codec: ResponseBody.uint8Array }),
  ],
});
