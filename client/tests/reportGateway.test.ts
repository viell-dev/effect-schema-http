import { DateTime, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { ExcelCsv, FixedWidthExtract, XmlRpcDateTime } from "../src/schemas/reportGateway.js";
import { digestAuthorization, parseDigestChallenge } from "../src/plans/signing.js";
import {
  adminSummary,
  exportCsv,
  fetchExtract,
  reportLogin,
  rpcCountTasks,
  rpcFetchExtract,
  rpcListTasks,
  rpcUnknownMethod,
} from "../src/services/reportClient.js";
import { setReportSession } from "../src/session.js";
import { call, expectTag, servicesUp } from "./support.js";

const up = await servicesUp([4400]);

describe.runIf(up)("Report gateway — XML-RPC, fixed-width tape records, and a German CSV", () => {
  let session = "";

  beforeAll(async () => {
    const ok = await call(
      // The credentials go in the query string. That is what this endpoint is.
      reportLogin().setUrlParam("user", "finance").setUrlParam("pass", "hunter2"),
      "ok",
    );
    session = expectTag(ok.body, "session").session;
    setReportSession(session);
  });

  it("hands out a session through a pipe-delimited line", () => {
    expect(session).toMatch(/^[0-9A-F]{16}$/u);
  });

  it("reports a login failure on the same channel as a success", async () => {
    const failed = await call(reportLogin().setUrlParam("user", "").setUrlParam("pass", ""), "ok");
    const error = expectTag(failed.body, "GatewayError");
    expect(error.code).toBe("E001");
  });

  describe("XML-RPC", () => {
    it("reads an array of structs with six differently-typed members", async () => {
      const ok = await call(rpcListTasks(session), "ok");
      const tasks = expectTag(ok.body, "ok").value;

      expect(tasks).toHaveLength(4);
      // <string>, with entities and a UTF-8 payload.
      expect(tasks[0]?.title).toBe("Migrate Löhne ledger");
      // <i4>, decoded through the same ordinal mapping the Java service uses.
      expect(tasks[0]?.status).toBe("DONE");
      // <double> of currency units, held as integer cents.
      expect(tasks[0]?.amount).toBe(1234500);
      // <boolean>, which is 1 or 0.
      expect(tasks[0]?.active).toBe(true);
      // <dateTime.iso8601>, which has no timezone and never will.
      expect(DateTime.isDateTime(tasks[0]!.extracted)).toBe(true);
    });

    it("reads a bare scalar as a complete response", async () => {
      const ok = await call(rpcCountTasks(session), "ok");
      expect(expectTag(ok.body, "ok").value).toBe(4);
    });

    it("carries a fault inside a perfectly successful HTTP response", async () => {
      const ok = await call(rpcUnknownMethod(session), "ok");
      const fault = expectTag(ok.body, "RpcFault");
      expect(fault.faultCode).toBe(-32601);
      expect(fault.faultString).toContain("not supported");
    });

    it("treats a bad session the same way, because there is no other way", async () => {
      const ok = await call(rpcListTasks("NOT-A-SESSION"), "ok");
      expect(expectTag(ok.body, "RpcFault").faultCode).toBe(401);
    });

    it("carries the fixed-width extract as base64 inside the XML", async () => {
      const ok = await call(rpcFetchExtract(session, "TASKS"), "ok");
      const extract = expectTag(ok.body, "ok").value;

      expect(extract.recordLength).toBe(63);
      expect(extract.data).toBeInstanceOf(Uint8Array);
      // Five 63-byte records: four details and a trailer. XML-RPC has no way to say
      // what the bytes mean, so the copybook is the only documentation — and the same
      // schema that reads the HTTP endpoint reads these bytes too.
      expect(extract.data.byteLength).toBe(5 * 63);
      const decoded = Schema.decodeSync(FixedWidthExtract)(extract.data);
      expect(decoded.records).toHaveLength(4);
    });
  });

  describe("the fixed-width extract over HTTP", () => {
    it("reads Latin-1 records with no delimiters and checks the trailer", async () => {
      const ok = await call(fetchExtract(), "ok");

      expect(ok.headers["x-record-length"]).toBe("63");
      expect(ok.body.records).toHaveLength(4);
      // Latin-1 bytes: reading this as text would have produced a replacement character.
      expect(ok.body.records[0]?.description).toBe("Migrate Löhne ledger");
      expect(ok.body.records[1]?.description).toBe("Rückstellungen review");
      expect(ok.body.records[2]?.description).toBe("Année fiscale closeout");
      // Two implied decimals, from a format with no room for a point.
      expect(ok.body.records[0]?.amount).toBe(1234500);
      // The control total finance reconciles against, checked rather than trusted.
      expect(ok.body.controlTotal).toBe(1234500 + 98750 + 4500000 + 0);
    });

    it("rejects an extract whose trailer does not reconcile", () => {
      const good = Schema.encodeSync(FixedWidthExtract)({
        records: [
          {
            id: "T0000001",
            description: "One record",
            status: "OPEN",
            date: DateTime.unsafeMake("2026-09-08T00:00:00Z"),
            amount: 1000 as never,
            active: true,
          },
        ],
        controlTotal: 1000 as never,
      });
      expect(Schema.decodeSync(FixedWidthExtract)(good).records).toHaveLength(1);

      // Corrupt the control total in place: the trailer is the last 63 bytes.
      const tampered = Uint8Array.from(good);
      tampered[good.length - 63 + 19] = "9".charCodeAt(0);
      expect(() => Schema.decodeSync(FixedWidthExtract)(tampered)).toThrow(/control total/u);
    });

    it("selects the error rule from a header, on a response that still says 200", async () => {
      const failed = await call(fetchExtract().setUrlParam("session", "NOT-A-SESSION"), "GatewayError");
      expect(failed.status).toBe(200);
      expect(failed.body.code).toBe("E401");
    });

    it("reports an unknown report the same way", async () => {
      const failed = await call(fetchExtract().setUrlParam("rpt", "LEDGER"), "GatewayError");
      expect(failed.body.code).toBe("E404");
    });
  });

  describe("the spreadsheet export", () => {
    it("strips the byte order mark before it can poison the first column name", async () => {
      const ok = await call(exportCsv(), "ok");

      expect(ok.body).toHaveLength(4);
      expect(ok.body[0]?.id).toBe("T0000001");
      expect(ok.body[0]?.description).toBe("Migrate Löhne ledger");
      // A decimal comma, read as cents.
      expect(ok.body[0]?.amount).toBe(1234500);
      expect(ok.body[3]?.status).toBe("REVIEW");
    });

    it("round-trips through the same schema", async () => {
      const ok = await call(exportCsv(), "ok");
      const bytes = Schema.encodeSync(ExcelCsv)(ok.body);
      // The BOM is written back, because the spreadsheet on the other end needs it.
      expect(bytes[0]).toBe(0xef);
      expect(Schema.decodeSync(ExcelCsv)(bytes)).toEqual(ok.body);
    });
  });

  describe("HTTP Digest, which needs two round trips and always will", () => {
    it("answers a challenge first, as a declared response rather than an error", async () => {
      const challenge = await call(adminSummary(), "challenge");

      expect(challenge.status).toBe(401);
      const fields = parseDigestChallenge(challenge.headers["www-authenticate"]);
      expect(fields["realm"]).toBe("Report Gateway");
      expect(fields["nonce"]).toMatch(/^[0-9a-f]{32}$/u);
      // The body is the gateway's usual pipe-delimited error line, because this service
      // has exactly one error format and uses it for everything.
      expect(challenge.body.code).toBe("E401");
    });

    it("answers the challenge by executing the same cold plan again", async () => {
      const challenge = await call(adminSummary(), "challenge");
      const fields = parseDigestChallenge(challenge.headers["www-authenticate"]);

      // Nothing is rebuilt: the plan is cold and re-executable, so answering a challenge
      // is one setter and a second execution. With a throwing client this is a catch
      // block that has to re-derive the status, re-parse the header, and re-enter the
      // happy path from outside it.
      const ok = await call(
        adminSummary().setHeader(
          "authorization",
          digestAuthorization(fields, "finance", "ledger99", "GET", "/cgi-bin/admin.pl"),
        ),
        "ok",
      );

      expect(ok.body.user).toBe("finance");
      expect(ok.body.records).toBe(4);
      expect(ok.headers["x-authenticated-user"]).toBe("finance");
    });

    it("refuses the same nonce twice, so every call costs two round trips forever", async () => {
      const challenge = await call(adminSummary(), "challenge");
      const fields = parseDigestChallenge(challenge.headers["www-authenticate"]);
      const authorization = digestAuthorization(fields, "finance", "ledger99", "GET", "/cgi-bin/admin.pl");

      await call(adminSummary().setHeader("authorization", authorization), "ok");

      // The nonce was spent by the successful call. A replay gets a fresh challenge
      // marked stale, which is how a client is told to retry rather than to prompt for a
      // password again.
      const replayed = await call(adminSummary().setHeader("authorization", authorization), "challenge");
      expect(replayed.headers["www-authenticate"]).toContain("stale=true");
    });

    it("refuses a wrong password", async () => {
      const challenge = await call(adminSummary(), "challenge");
      const fields = parseDigestChallenge(challenge.headers["www-authenticate"]);

      const refused = await call(
        adminSummary().setHeader(
          "authorization",
          digestAuthorization(fields, "finance", "not-the-password", "GET", "/cgi-bin/admin.pl"),
        ),
        "challenge",
      );
      expect(refused.status).toBe(401);
    });
  });

  it("reads the 1998 date format, which has no timezone at all", () => {
    const decoded = Schema.decodeSync(XmlRpcDateTime)("19980717T14:08:55");
    expect(DateTime.formatIso(decoded)).toBe("1998-07-17T14:08:55.000Z");
    expect(Schema.encodeSync(XmlRpcDateTime)(decoded)).toBe("19980717T14:08:55");
  });
});
