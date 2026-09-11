import { DateTime, ParseResult, Schema } from "effect";
import { TaskStatusFromOrdinal } from "./apiServer.js";
import { Cents } from "./apiLegacy.js";

/**
 * Schemas for the 1999 reporting gateway.
 *
 * Three wire formats, none of them JSON: XML-RPC, a fixed-width byte extract in
 * ISO-8859-1 with no record delimiters, and a CSV written for a German copy of Excel.
 * All three are read by pairing a non-JSON response codec with a schema, which is the
 * library's stated position on formats it has never heard of — "a text codec followed by
 * a `*FromString` schema can parse XML, YAML, a custom JSON dialect, or another textual
 * protocol without special support from this library".
 */

// ---------------------------------------------------------------------------
// The session, from a pipe-delimited line
// ---------------------------------------------------------------------------

/**
 * `OK|SESSION|<id>|USER|<name>` — the whole response, as a line of fields.
 *
 * Pipe-delimited because the author was reading it with `cut`, and every failure is
 * `ERROR|<code>|<message>` on the same channel: this service has no other way to say
 * anything went wrong.
 */
export const LoginLine = Schema.transformOrFail(
  Schema.String,
  Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("session"), session: Schema.String, user: Schema.String }),
    Schema.Struct({ _tag: Schema.Literal("GatewayError"), code: Schema.String, message: Schema.String }),
  ),
  {
    strict: true,
    decode: (raw, _options, ast) => {
      const [outcome, ...fields] = raw.trim().split("|");
      if (outcome === "ERROR") {
        return ParseResult.succeed({
          _tag: "GatewayError" as const,
          code: fields[0] ?? "E000",
          message: fields[1] ?? "unspecified",
        });
      }
      if (outcome === "OK" && fields[0] === "SESSION") {
        return ParseResult.succeed({
          _tag: "session" as const,
          session: fields[1] ?? "",
          user: fields[3] ?? "",
        });
      }
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected an OK|SESSION or ERROR line"));
    },
    encode: (value) =>
      ParseResult.succeed(
        value._tag === "session"
          ? `OK|SESSION|${value.session}|USER|${value.user}`
          : `ERROR|${value.code}|${value.message}`,
      ),
  },
);
export type LoginLine = typeof LoginLine.Type;

/** The `ERROR|code|message` line on its own, for the endpoints that only ever send it. */
export const GatewayErrorLine = Schema.transformOrFail(
  Schema.String,
  Schema.Struct({ _tag: Schema.Literal("GatewayError"), code: Schema.String, message: Schema.String }),
  {
    strict: true,
    decode: (raw, _options, ast) => {
      const [outcome, code, message] = raw.trim().split("|");
      return outcome === "ERROR"
        ? ParseResult.succeed({
            _tag: "GatewayError" as const,
            code: code ?? "E000",
            message: message ?? "unspecified",
          })
        : ParseResult.fail(new ParseResult.Type(ast, raw, "expected an ERROR line"));
    },
    encode: (value) => ParseResult.succeed(`ERROR|${value.code}|${value.message}`),
  },
);

// ---------------------------------------------------------------------------
// XML-RPC
// ---------------------------------------------------------------------------

/**
 * XML-RPC's own date format, from the 1998 specification: `19980717T14:08:55`.
 *
 * No separators in the date, colons in the time, and **no timezone**, which the
 * specification acknowledges and declines to fix. The only defensible reading is UTC.
 */
export const XmlRpcDateTime = Schema.transformOrFail(Schema.String, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (raw, _options, ast) => {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u.exec(raw.trim());
    if (match === null) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected XML-RPC dateTime.iso8601"));
    }
    const [, year, month, day, hours, minutes, seconds] = match;
    return ParseResult.succeed(DateTime.unsafeMake(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`));
  },
  encode: (value) =>
    ParseResult.succeed(DateTime.formatIso(value).replace(/-/gu, "").replace(/\.\d+Z$/u, "")),
});

const decodeEntities = (value: string): string =>
  value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s+/gu, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/**
 * Reads one XML-RPC `<value>` into a plain JavaScript value.
 *
 * The type tags are the 1998 set: `<i4>` and `<int>` are the same thing, `<boolean>` is
 * `1` or `0`, a `<value>` with no type element at all is a string, and `<base64>` is the
 * only way to carry bytes. `<dateTime.iso8601>` is deliberately left as a string so the
 * schema layer can decide what it means — this parser reads structure, not meaning.
 */
const readValue = (xml: string): unknown => {
  const trimmed = xml.trim();

  const structMatch = /^<struct>([\s\S]*)<\/struct>$/u.exec(trimmed);
  if (structMatch !== null) {
    const record: Record<string, unknown> = {};
    const members = structMatch[1] ?? "";
    for (const member of members.matchAll(/<member>([\s\S]*?)<\/member>/gu)) {
      const body = member[1] ?? "";
      const name = /<name>([\s\S]*?)<\/name>/u.exec(body)?.[1]?.trim() ?? "";
      const value = /<value>([\s\S]*)<\/value>/u.exec(body)?.[1] ?? "";
      record[decodeEntities(name)] = readValue(value);
    }
    return record;
  }

  const arrayMatch = /^<array>\s*<data>([\s\S]*)<\/data>\s*<\/array>$/u.exec(trimmed);
  if (arrayMatch !== null) {
    const items: Array<unknown> = [];
    let depth = 0;
    let start = -1;
    const data = arrayMatch[1] ?? "";
    // <value> nests, so the members cannot be split with a regular expression.
    for (const token of data.matchAll(/<(\/?)value>/gu)) {
      if (token[1] === "") {
        if (depth === 0) start = token.index + token[0].length;
        depth += 1;
      } else {
        depth -= 1;
        if (depth === 0 && start >= 0) items.push(readValue(data.slice(start, token.index)));
      }
    }
    return items;
  }

  const typed = /^<(i4|int|double|boolean|string|base64|dateTime\.iso8601)>([\s\S]*?)<\/\1>$/u.exec(trimmed);
  if (typed === null) return decodeEntities(trimmed);

  const [, type, raw = ""] = typed;
  switch (type) {
    case "i4":
    case "int":
    case "double":
      return Number(raw.trim());
    case "boolean":
      return raw.trim() === "1";
    case "base64":
      return decodeBase64(raw);
    default:
      return decodeEntities(raw);
  }
};

/** A `<fault>`, which XML-RPC transports inside a perfectly successful HTTP response. */
export const RpcFault = Schema.Struct({
  _tag: Schema.Literal("RpcFault"),
  faultCode: Schema.Number,
  faultString: Schema.String,
});
export type RpcFault = typeof RpcFault.Type;

/**
 * Wraps a schema so an XML-RPC `<fault>` becomes a tagged union member.
 *
 * The same shape as the SOAP service's `soapResult`, for the same reason and from a
 * completely different decade: the transport says `200` whatever happened, so the
 * discrimination has to live in the schema. Two services, two protocols, one idea.
 */
export const rpcResult = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.transformOrFail(
    Schema.String,
    Schema.Union(Schema.Struct({ _tag: Schema.Literal("ok"), value: Schema.typeSchema(schema) }), RpcFault),
    {
      strict: false,
      decode: (xml, options, ast) => {
        const fault = /<fault>\s*<value>([\s\S]*?)<\/value>\s*<\/fault>/u.exec(xml);
        if (fault !== null) {
          const record = readValue(fault[1] ?? "") as Record<string, unknown>;
          return ParseResult.succeed({
            _tag: "RpcFault" as const,
            faultCode: Number(record["faultCode"] ?? -1),
            faultString: String(record["faultString"] ?? "unspecified fault"),
          });
        }

        const parameter = /<params>\s*<param>\s*<value>([\s\S]*)<\/value>\s*<\/param>\s*<\/params>/u.exec(xml);
        if (parameter === null) {
          return ParseResult.fail(new ParseResult.Type(ast, xml, "neither a <params> nor a <fault> response"));
        }

        return ParseResult.map(ParseResult.decodeUnknown(schema)(readValue(parameter[1] ?? ""), options), (value) => ({
          _tag: "ok" as const,
          value,
        }));
      },
      encode: (result, _options, ast) =>
        ParseResult.fail(new ParseResult.Type(ast, result, "this client reads XML-RPC responses, it does not serve them")),
    },
  );

/** Builds a `<methodCall>` document. Values are strings; this gateway needs nothing else. */
export const methodCall = (method: string, parameters: ReadonlyArray<string>): string =>
  `<?xml version="1.0"?>\n<methodCall><methodName>${method}</methodName><params>` +
  parameters
    .map((parameter) => `<param><value><string>${parameter.replace(/&/gu, "&amp;").replace(/</gu, "&lt;")}</string></value></param>`)
    .join("") +
  `</params></methodCall>`;

/**
 * One task, as the gateway's nightly extract sees it.
 *
 * `status` is the same ordinal the Java service serializes, and decoded through the
 * same schema, because the gateway's extract genuinely is a dump of that system's
 * table. Sharing the mapping here is not coupling two unrelated services — it is one
 * fact with one definition, which is exactly the case where sharing is correct.
 */
export const ReportTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TaskStatusFromOrdinal,
  // `<double>` of currency units, which the rest of this client holds as integer cents.
  amount: Schema.transform(Schema.Number, Cents, {
    strict: true,
    decode: (units) => Cents.make(Math.round(units * 100)),
    encode: (cents) => cents / 100,
  }),
  active: Schema.Boolean,
  extracted: XmlRpcDateTime,
});
export type ReportTask = typeof ReportTask.Type;

/** `report.fetch` — a named extract, its record length, and its bytes. */
export const RpcExtract = Schema.Struct({
  name: Schema.String,
  recordLength: Schema.Number,
  data: Schema.Uint8ArrayFromSelf,
});

// ---------------------------------------------------------------------------
// The fixed-width extract
// ---------------------------------------------------------------------------

/**
 * One detail record from the copybook.
 *
 * ```
 * 01-02  record type      "01" detail, "99" trailer
 * 03-10  task id
 * 11-40  description      ISO-8859-1, space padded
 * 41-42  status code      "00".."04"
 * 43-50  date             YYYYMMDD
 * 51-60  amount           zero padded, two implied decimals
 * 61-61  active flag      Y/N
 * 62-63  filler
 * ```
 */
export const ExtractRecord = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  status: TaskStatusFromOrdinal,
  date: Schema.DateTimeUtcFromSelf,
  amount: Cents,
  active: Schema.Boolean,
});
export type ExtractRecord = typeof ExtractRecord.Type;

const RECORD_LENGTH = 63;

/**
 * The whole extract: fixed-length records, ISO-8859-1, and no delimiters of any kind.
 *
 * Three things make this a `ResponseBody.uint8Array` case rather than a text one. The
 * bytes are Latin-1 and the `Content-Type` is a bare `text/plain` with no charset, so
 * reading it as text replaces every umlaut. The records have no terminator, so the only
 * way to find their boundaries is to count bytes. And the trailer carries a control
 * total that finance reconciles against, so the decode has to *check* something rather
 * than just reshape it — a record count and a sum that must agree with the details, or
 * the file is rejected rather than half-read.
 */
export const FixedWidthExtract = Schema.transformOrFail(
  Schema.Uint8ArrayFromSelf,
  Schema.Struct({
    records: Schema.Array(Schema.typeSchema(ExtractRecord)),
    controlTotal: Cents,
  }),
  {
    strict: true,
    decode: (bytes, _options, ast) => {
      if (bytes.length === 0 || bytes.length % RECORD_LENGTH !== 0) {
        return ParseResult.fail(
          new ParseResult.Type(ast, bytes, `expected a multiple of ${RECORD_LENGTH} bytes, received ${bytes.length}`),
        );
      }

      const latin1 = new TextDecoder("iso-8859-1");
      const records: Array<ExtractRecord> = [];
      let declaredCount: number | undefined;
      let declaredTotal: number | undefined;

      for (let offset = 0; offset < bytes.length; offset += RECORD_LENGTH) {
        const line = latin1.decode(bytes.slice(offset, offset + RECORD_LENGTH));
        const kind = line.slice(0, 2);

        if (kind === "99") {
          declaredCount = Number(line.slice(2, 10));
          declaredTotal = Number(line.slice(10, 20));
          continue;
        }
        if (kind !== "01") {
          return ParseResult.fail(new ParseResult.Type(ast, bytes, `unknown record type ${JSON.stringify(kind)}`));
        }

        const date = line.slice(42, 50);
        const status = Number(line.slice(40, 42));
        if (status < 0 || status > 4) {
          return ParseResult.fail(new ParseResult.Type(ast, bytes, `unknown status code ${status}`));
        }

        records.push({
          id: line.slice(2, 10).trimEnd(),
          description: line.slice(10, 40).trimEnd(),
          status: (["OPEN", "IN_PROGRESS", "REVIEW", "DONE", "CANCELLED"] as const)[status]!,
          date: DateTime.unsafeMake(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`),
          // Two implied decimals: the tape format had no room for a point.
          amount: Cents.make(Number(line.slice(50, 60))),
          active: line.slice(60, 61) === "Y",
        });
      }

      if (declaredCount === undefined || declaredTotal === undefined) {
        return ParseResult.fail(new ParseResult.Type(ast, bytes, "the extract has no trailer record"));
      }
      if (declaredCount !== records.length) {
        return ParseResult.fail(
          new ParseResult.Type(ast, bytes, `trailer says ${declaredCount} records, found ${records.length}`),
        );
      }
      const sum = records.reduce((total, record) => total + record.amount, 0);
      if (sum !== declaredTotal) {
        return ParseResult.fail(
          new ParseResult.Type(ast, bytes, `control total ${declaredTotal} does not match the detail sum ${sum}`),
        );
      }

      return ParseResult.succeed({ records, controlTotal: Cents.make(declaredTotal) });
    },
    encode: (extract) => {
      const pad = (value: string, width: number) => value.padEnd(width, " ").slice(0, width);
      const statuses = ["OPEN", "IN_PROGRESS", "REVIEW", "DONE", "CANCELLED"] as const;
      let text = "";
      for (const record of extract.records) {
        const parts = DateTime.toParts(record.date);
        const date =
          `${parts.year}` +
          `${String(parts.month).padStart(2, "0")}` +
          `${String(parts.day).padStart(2, "0")}`;
        text +=
          "01" +
          pad(record.id, 8) +
          pad(record.description, 30) +
          String(statuses.indexOf(record.status)).padStart(2, "0") +
          date +
          String(record.amount).padStart(10, "0") +
          (record.active ? "Y" : "N") +
          "  ";
      }
      text +=
        "99" +
        String(extract.records.length).padStart(8, "0") +
        String(extract.controlTotal).padStart(10, "0") +
        " ".repeat(RECORD_LENGTH - 20);

      // Latin-1 out, matching what came in.
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        bytes[index] = code < 256 ? code : 0x3f;
      }
      return ParseResult.succeed(bytes);
    },
  },
);
export type FixedWidthExtract = typeof FixedWidthExtract.Type;

// ---------------------------------------------------------------------------
// The spreadsheet export
// ---------------------------------------------------------------------------

/**
 * The CSV, as a German copy of Excel wants it: a UTF-8 byte order mark, CRLF line
 * endings, semicolon separators, and a decimal comma.
 *
 * The BOM is why this is bytes rather than text. `Response.text()` leaves it in place as
 * `U+FEFF`, so the first column's name silently becomes `﻿ID` and every lookup by
 * header name misses — a failure that shows up as one empty column and nothing else.
 */
export const ExcelCsv = Schema.transformOrFail(
  Schema.Uint8ArrayFromSelf,
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      description: Schema.String,
      status: TaskStatusFromOrdinal,
      date: Schema.String,
      amount: Cents,
      active: Schema.Boolean,
    }),
  ),
  {
    strict: true,
    decode: (bytes, _options, ast) => {
      const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const text = new TextDecoder("utf-8").decode(hasBom ? bytes.slice(3) : bytes);
      const lines = text.split("\r\n").filter((line) => line.trim() !== "");
      const [header, ...rows] = lines;

      if (header === undefined || !header.startsWith("ID;")) {
        return ParseResult.fail(new ParseResult.Type(ast, bytes, "expected a semicolon-delimited header row"));
      }

      // The encoded side of the target: the status ordinal and the amount in cents are
      // decoded by the schema itself, which is where the ordinal's meaning is defined.
      return ParseResult.succeed(
        rows.map((row) => {
          const [id = "", description = "", status = "0", date = "", amount = "0", active = "N"] = row.split(";");
          return {
            id,
            description,
            status: Number(status),
            date,
            // Decimal comma, and cents rather than a float.
            amount: Math.round(Number(amount.replace(",", ".")) * 100),
            active: active.trim() === "Y",
          };
        }),
      );
    },
    // `encode` receives the target's *encoded* form, so the status is already the
    // ordinal the gateway writes and the amount is already in cents.
    encode: (rows) => {
      const text =
        "﻿ID;Beschreibung;Status;Datum;Betrag;Aktiv\r\n" +
        rows
          .map((row) =>
            [
              row.id,
              row.description,
              row.status,
              row.date,
              (row.amount / 100).toFixed(2).replace(".", ","),
              row.active ? "Y" : "N",
            ].join(";"),
          )
          .join("\r\n") +
        "\r\n";
      return ParseResult.succeed(new TextEncoder().encode(text));
    },
  },
);
