import { HttpBody } from "@effect/platform";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
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
import { configure, executionOptions, type Options } from "./options.js";
export const REPORT_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_REPORT_SERVER_URL) || "http://localhost:4400";

export const reportRequest = (method: string, path: string, options: Options) =>
  Request.make(method, path).pipe(
    Request.baseUrl(REPORT_SERVER_URL),
    Request.setQuery("session", () => getReportSession()),
    configure(options),
  );

/** GET /cgi-bin/login.pl. */
export const reportLogin = (options: Options = {}) =>
  Operation.make(
    reportRequest("GET", "/cgi-bin/login.pl", {}).pipe(Request.removeQuery("session"), configure(options)),
    Response.status(
      200,
      Body.text.pipe(Body.schema(LoginLine), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** GET /cgi-bin/admin.pl. */
export const adminSummary = (options: Options = {}) =>
  Operation.make(
    reportRequest("GET", "/cgi-bin/admin.pl", {}).pipe(Request.removeQuery("session"), configure(options)),
    Response.status(
      401,
      Body.text.pipe(Body.schema(GatewayErrorLine), (decoder) => Response.tag("challenge", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          200,
          Body.text.pipe(Body.schema(AdminSummaryLine), (decoder) => Response.tag("ok", decoder)),
        ),
      ),
    ),
    executionOptions(options),
  );

/** GET /cgi-bin/report.pl. */
export const fetchExtract = (options: Options = {}) =>
  Operation.make(
    reportRequest("GET", "/cgi-bin/report.pl", {}).pipe(Request.setQuery("rpt", "TASKS"), configure(options)),
    Response.when(
      (metadata) => metadata.status === 200 && ((value) => value !== undefined)(metadata.headers["x-error-code"]),
      Body.text.pipe(Body.schema(GatewayErrorLine), (decoder) => Response.tag("GatewayError", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          200,
          Body.bytes.pipe(Body.schema(FixedWidthExtract), (decoder) => Response.tag("ok", decoder)),
        ),
      ),
    ),
    executionOptions(options),
  );

/** GET /cgi-bin/export.pl. */
export const exportCsv = (options: Options = {}) =>
  Operation.make(
    reportRequest("GET", "/cgi-bin/export.pl", {}).pipe(Request.setQuery("rpt", "TASKS"), configure(options)),
    Response.when(
      (metadata) => metadata.status === 200 && ((value) => value !== undefined)(metadata.headers["x-error-code"]),
      Body.text.pipe(Body.schema(GatewayErrorLine), (decoder) => Response.tag("GatewayError", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          200,
          Body.bytes.pipe(Body.schema(ExcelCsv), (decoder) => Response.tag("ok", decoder)),
        ),
      ),
    ),
    executionOptions(options),
  );

// XML-RPC outcomes discriminate within the payload, since every outcome has status 200.
const rpc = <A, I, R>(method: string, parameters: ReadonlyArray<string>, schema: Schema.Schema<A, I, R>) =>
  Operation.make(
    reportRequest("POST", "/cgi-bin/rpc.pl", {}).pipe(
      Request.removeQuery("session"),
      Request.body(Body.encoder((value: string) => Effect.succeed(HttpBody.text(value, "text/xml")))),
    ),
    Response.status(
      200,
      Body.text.pipe(Body.schema(rpcResult(schema)), (decoder) => Response.tag("ok", decoder)),
    ),
  ).execute({ body: methodCall(method, parameters) });

export const rpcListTasks = (session: string) => rpc("report.list", [session], Schema.Array(ReportTask));
export const rpcCountTasks = (session: string) => rpc("report.count", [session], Schema.Number);
export const rpcFetchExtract = (session: string, name: string) => rpc("report.fetch", [session, name], RpcExtract);
export const rpcUnknownMethod = (session: string) => rpc("report.doesNotExist", [session], Schema.Unknown);
