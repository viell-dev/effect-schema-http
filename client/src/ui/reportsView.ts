import { DateTime, Schema } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h } from "../dom.js";
import { FixedWidthExtract } from "../schemas/reportGateway.js";
import { run } from "../runtime.js";
import {
  exportCsv,
  fetchExtract,
  reportLogin,
  rpcCountTasks,
  rpcFetchExtract,
  rpcListTasks,
  rpcUnknownMethod,
} from "../services/reportClient.js";
import { getReportSession, setReportSession } from "../session.js";
import { actionPanel, field, show, type Action } from "./panel.js";

/** Every call in this view goes to the Perl reporting gateway on :4400. */
export const renderReportsView = (): HTMLElement => {
  const user = field("user", "finance");
  const pass = field("password", "hunter2");

  const requireSession = (): string => {
    const session = getReportSession();
    if (session === undefined) throw new Error("sign in to the gateway first — it has its own session");
    return session;
  };

  const actions: ReadonlyArray<Action> = [
    {
      label: "Sign in (credentials in the URL)",
      note: "A GET with the password in the query string. Two crontabs still call it this way.",
      run: async () => {
        const result = await run(
          reportLogin().setUrlParam("user", user.input.value).setUrlParam("pass", pass.input.value).pipe(toEffect),
        );
        if (result._tag !== "ok") return show(result);
        if (result.body._tag === "GatewayError") return `${result.body.code}: ${result.body.message}`;
        setReportSession(result.body.session);
        return `session ${result.body.session}\n\nThe password is now in the access log, the proxy log, and the referrer of every link on the page that follows.`;
      },
    },
    {
      label: "XML-RPC: report.list",
      note: "An array of structs with <i4>, <double>, <boolean> and a 1998 dateTime with no timezone.",
      run: async () => {
        const result = await run(rpcListTasks(requireSession()).pipe(toEffect));
        if (result._tag !== "ok") return show(result);
        if (result.body._tag === "RpcFault") return `fault ${result.body.faultCode}: ${result.body.faultString}`;
        return result.body.value
          .map(
            (task) =>
              `${task.id}  ${task.status.padEnd(12)} ${(task.amount / 100).toFixed(2).padStart(10)}  ` +
              `${task.active ? "Y" : "N"}  ${task.title}`,
          )
          .join("\n");
      },
    },
    {
      label: "XML-RPC: report.count",
      note: "A bare <i4> is a complete response; there is no envelope to look inside.",
      run: async () => {
        const result = await run(rpcCountTasks(requireSession()).pipe(toEffect));
        if (result._tag !== "ok") return show(result);
        return result.body._tag === "ok" ? `${result.body.value} records` : show(result.body);
      },
    },
    {
      label: "XML-RPC: an unknown method",
      note: "A fault, carried inside a perfectly successful HTTP response. That is the protocol.",
      run: async () => {
        const result = await run(rpcUnknownMethod(requireSession()).pipe(toEffect));
        if (result._tag !== "ok") return show(result);
        return result.body._tag === "RpcFault"
          ? `HTTP ${result.status}, fault ${result.body.faultCode}: ${result.body.faultString}`
          : "unexpectedly succeeded";
      },
    },
    {
      label: "XML-RPC: report.fetch (base64)",
      note: "The same fixed-width extract, wrapped in base64 inside the XML because XML-RPC has no other way.",
      run: async () => {
        const result = await run(rpcFetchExtract(requireSession(), "TASKS").pipe(toEffect));
        if (result._tag !== "ok") return show(result);
        if (result.body._tag === "RpcFault") return `fault ${result.body.faultCode}`;
        const extract = Schema.decodeSync(FixedWidthExtract)(result.body.value.data);
        return [
          `${result.body.value.data.byteLength} bytes, ${result.body.value.recordLength}-byte records`,
          `${extract.records.length} records, control total ${(extract.controlTotal / 100).toFixed(2)}`,
        ].join("\n");
      },
    },
    {
      label: "Fetch the fixed-width extract",
      note: "Latin-1, no delimiters, and a trailer whose control total the schema checks.",
      run: async () => {
        const result = await run(fetchExtract().pipe(toEffect));
        if (result._tag === "GatewayError") return `${result.body.code}: ${result.body.message}`;
        return [
          `record length ${result.headers["x-record-length"]}, copybook ${result.headers["x-copybook"]}`,
          "",
          ...result.body.records.map(
            (record) =>
              `${record.id}  ${DateTime.formatIso(record.date).slice(0, 10)}  ${record.status.padEnd(12)}` +
              `${(record.amount / 100).toFixed(2).padStart(12)}  ${record.description}`,
          ),
          "",
          `control total ${(result.body.controlTotal / 100).toFixed(2)} — checked, not trusted`,
        ].join("\n");
      },
    },
    {
      label: "Fetch it with a bad session",
      note: "A 200 with X-Error-Code. The load balancer ejected any node that answered otherwise.",
      run: async () => {
        const result = await run(fetchExtract().setUrlParam("session", "NOT-A-SESSION").pipe(toEffect));
        return result._tag === "GatewayError"
          ? `HTTP ${result.status}, X-Error-Code selected the rule: ${result.body.code} ${result.body.message}`
          : "unexpectedly succeeded";
      },
    },
    {
      label: "Export the CSV",
      note: "A UTF-8 BOM, CRLF, semicolons and a decimal comma, served as octet-stream.",
      run: async () => {
        const result = await run(exportCsv().pipe(toEffect));
        if (result._tag === "GatewayError") return `${result.body.code}: ${result.body.message}`;
        return [
          ...result.body.map(
            (row) => `${row.id}  ${row.status.padEnd(12)} ${(row.amount / 100).toFixed(2).padStart(10)}  ${row.description}`,
          ),
          "",
          "The BOM was stripped before parsing; left in place it becomes part of the first column's name.",
        ].join("\n");
      },
    },
  ];

  return h(
    "div",
    {},
    h("div", { class: "fields" }, user.row, pass.row),
    actionPanel(
      "Perl reporting gateway, :4400",
      "The oldest thing still running. XML-RPC, a fixed-width tape extract in ISO-8859-1, a CSV for a German spreadsheet, and a session that travels in the URL.",
      actions,
    ),
  );
};
