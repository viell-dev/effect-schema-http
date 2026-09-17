import { DateTime, Option, ParseResult, Schema } from "effect";
import { EpochMillis, taggedBody, YesNo } from "./common.js";

/**
 * Schemas for the parts of the Java API that predate the rest of it.
 *
 * Almost everything in this file is a `Schema.transform` or `Schema.transformOrFail`
 * whose *encoded* side is a shape nobody would design and whose *type* side is what the
 * application actually wants. That split is the whole job: the services were written by
 * five teams over twelve years and none of them will change, so every reconciliation
 * happens here, once, in a form that also runs backwards.
 */

// ---------------------------------------------------------------------------
// Numbers that JSON cannot carry
// ---------------------------------------------------------------------------

/**
 * A 64-bit identity value, kept exact.
 *
 * The orders table's primary key passed 2^53 in 2019. `JSON.parse` silently rounds
 * anything above it, so `9007199254740993` becomes `9007199254740992` and two orders
 * collide — the failure is invisible, and it corrupts data rather than throwing.
 *
 * The column is therefore a *string* in this client, branded so it cannot be confused
 * with a project id or accidentally fed to arithmetic.
 */
export const OrderId = Schema.String.pipe(
  Schema.pattern(/^\d+$/u),
  Schema.brand("OrderId"),
  Schema.annotations({ identifier: "OrderId", description: "A 64-bit order id, carried as a string" }),
);
export type OrderId = typeof OrderId.Type;

/**
 * A JSON parser that promotes long integers to strings before `JSON.parse` sees them.
 *
 * This is the reason `Body.text` exists. The library's default JSON codec calls
 * the platform parser, which is the very thing losing the precision, so the fix cannot
 * live in a schema applied *after* parsing — by then the digits are gone. Reading the
 * payload as text and installing a different JSON dialect underneath the real schema is
 * the documented escape hatch, and it needs no support from the library beyond choosing
 * a codec.
 *
 * The rewrite is deliberately narrow: only a run of 16 or more digits in value position
 * is quoted, so ordinary numbers keep their type.
 */
const LosslessJson = Schema.transformOrFail(Schema.String, Schema.Unknown, {
  strict: true,
  decode: (raw, _options, ast) => {
    const guarded = raw.replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/gu, ': "$1"');
    try {
      return ParseResult.succeed(JSON.parse(guarded) as unknown);
    } catch (cause) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, `not JSON: ${String(cause)}`));
    }
  },
  encode: (value) => ParseResult.succeed(JSON.stringify(value)),
});

/** Reads a payload as text and decodes it with `schema` through the lossless parser. */
export const losslessJsonOf = <A, I, R>(schema: Schema.Schema<A, I, R>): Schema.Schema<A, string, R> =>
  Schema.compose(LosslessJson, schema, { strict: false });

// ---------------------------------------------------------------------------
// Dates nobody should still be sending
// ---------------------------------------------------------------------------

/**
 * The ASP.NET AJAX date format: `/Date(1262304000000)/`, optionally with an offset.
 *
 * The offset is decorative — the value before it is already UTC milliseconds — which is
 * the single most common way this format is misread. It is parsed and discarded rather
 * than applied.
 */
export const AspNetDate = Schema.transformOrFail(Schema.String, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (raw, _options, ast) => {
    const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/u.exec(raw.trim());
    if (match === null) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected /Date(milliseconds)/"));
    }
    return ParseResult.succeed(DateTime.unsafeMake(Number(match[1])));
  },
  encode: (value) => ParseResult.succeed(`/Date(${DateTime.toEpochMillis(value)})/`),
});

/**
 * A MySQL `DATE` column that used `0000-00-00` for "never", because the schema was
 * `NOT NULL` and somebody needed a value.
 *
 * `new Date("0000-00-00")` is `Invalid Date`, which then formats as the string
 * `"Invalid Date"` and reaches a user interface. Decoding it to `null` is the point.
 */
export const MysqlNullableDate = Schema.transformOrFail(Schema.String, Schema.NullOr(Schema.DateTimeUtcFromSelf), {
  strict: true,
  decode: (raw, _options, ast) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "0000-00-00") return ParseResult.succeed(null);
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed)) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected YYYY-MM-DD or the zero date"));
    }
    return ParseResult.succeed(DateTime.unsafeMake(parsed));
  },
  encode: (value) =>
    ParseResult.succeed(value === null ? "0000-00-00" : DateTime.formatIso(value).slice(0, 10)),
});

// ---------------------------------------------------------------------------
// Money, which is never a float
// ---------------------------------------------------------------------------

/** Minor units. Money is an integer count of cents here, never a binary fraction. */
export const Cents = Schema.Int.pipe(Schema.brand("Cents"));
export type Cents = typeof Cents.Type;

/**
 * `"$1,234.50"` — a currency symbol, thousands separators, and two decimal places, all
 * baked into a string by a report server's locale twelve years ago.
 *
 * Decoding to `Number("1234.50")` would be wrong twice over: it loses the currency, and
 * it makes money a float. This decodes to integer cents and fails on anything it does
 * not recognize, rather than producing `NaN` and letting it spread.
 */
export const UsdFromDisplay = Schema.transformOrFail(Schema.String, Cents, {
  strict: true,
  decode: (raw, _options, ast) => {
    const match = /^\$\s*(-?[\d,]+)\.(\d{2})$/u.exec(raw.trim());
    if (match === null) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected a US-formatted dollar amount"));
    }
    const whole = Number(match[1]?.replace(/,/gu, ""));
    const fraction = Number(match[2]);
    if (!Number.isSafeInteger(whole)) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "amount is too large to be exact"));
    }
    return ParseResult.succeed(Cents.make(whole * 100 + (whole < 0 ? -fraction : fraction)));
  },
  encode: (cents) => {
    const negative = cents < 0;
    const absolute = Math.abs(cents);
    const whole = Math.floor(absolute / 100).toLocaleString("en-US");
    const fraction = (absolute % 100).toString().padStart(2, "0");
    return ParseResult.succeed(`${negative ? "-" : ""}$${whole}.${fraction}`);
  },
});

// ---------------------------------------------------------------------------
// Absence, spelled four ways
// ---------------------------------------------------------------------------

/**
 * A field whose "no value" is `null`, `""`, the literal string `"null"`, or the key
 * being absent — depending on which of four importers wrote the row.
 *
 * Collapsing all four into `Option.none()` at the boundary is the only way the rest of
 * the client can stop caring which importer it was.
 */
export const AbsentFourWays = Schema.transform(Schema.NullOr(Schema.String), Schema.OptionFromSelf(Schema.String), {
  strict: true,
  decode: (raw) =>
    raw === null || raw.trim() === "" || raw.trim().toLowerCase() === "null" ? Option.none() : Option.some(raw),
  encode: (value) => Option.getOrNull(value),
});

/** `-1` meaning "no limit", which is not a number of dollars. */
export const CreditLimit = Schema.transform(
  Schema.Number,
  Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("unlimited") }),
    Schema.Struct({ _tag: Schema.Literal("limited"), amount: Schema.Number }),
  ),
  {
    strict: true,
    decode: (value) => (value < 0 ? ({ _tag: "unlimited" } as const) : ({ _tag: "limited", amount: value } as const)),
    encode: (value) => (value._tag === "unlimited" ? -1 : value.amount),
  },
);

/**
 * A reference that is an object when the row came from the 2018 importer and a bare id
 * string when it came from anything older.
 *
 * `Schema.Union` over the two encoded shapes, normalized to one type. This is the
 * library's documented answer to a payload that varies while its envelope does not, and
 * it is the right answer here because nothing about the *transport* distinguishes them.
 */
export const CustomerRef = Schema.transform(
  Schema.Union(Schema.Struct({ id: Schema.String, name: Schema.String }), Schema.String),
  Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  {
    strict: true,
    decode: (value) => (typeof value === "string" ? { id: value, name: null } : value),
    encode: (value) => (value.name === null ? value.id : { id: value.id, name: value.name }),
  },
);

// ---------------------------------------------------------------------------
// GET /api/odata/Orders
// ---------------------------------------------------------------------------

/** One order, with every one of the conventions above in a single object. */
export const Order = Schema.Struct({
  __metadata: Schema.Struct({ uri: Schema.String, type: Schema.String }),
  // Both columns decode to the exact value, because the text parser quoted the long
  // integer before `JSON.parse` could round it. A test proves the loss separately by
  // re-reading the same payload with the platform parser.
  id: OrderId,
  idStr: OrderId,
  project: Schema.String,
  orderDate: AspNetDate,
  amount: UsdFromDisplay,
  taxRate: Schema.NumberFromString,
  active: YesNo,
  cancelledOn: MysqlNullableDate,
  creditLimit: CreditLimit,
  notes: Schema.optionalWith(AbsentFourWays, { default: () => Option.none<string>() }),
  customerRef: CustomerRef,
});
export type Order = typeof Order.Type;

/**
 * The OData v2 envelope: `{"d":{"results":[…],"__count":"3"}}`.
 *
 * `d` existed to defeat a JSON array hijacking attack that stopped being possible in
 * 2011, and `__count` is a string because the serializer stringified every number it
 * did not trust JavaScript with. Unwrapping both in the schema means no view ever sees
 * either.
 */
export const OrderPage = Schema.transform(
  Schema.Struct({
    d: Schema.Struct({
      results: Schema.Array(Order),
      __count: Schema.NumberFromString,
    }),
  }),
  Schema.Struct({ orders: Schema.Array(Schema.typeSchema(Order)), total: Schema.Number }),
  {
    strict: true,
    decode: (envelope) => ({ orders: envelope.d.results, total: envelope.d.__count }),
    encode: (page) => ({ d: { results: page.orders, __count: page.total } }),
  },
);
export type OrderPage = typeof OrderPage.Type;

// ---------------------------------------------------------------------------
// GET /api/reports/grid
// ---------------------------------------------------------------------------

const GRID_COLUMNS = ["id", "projectId", "title", "status", "priority", "updatedAt"] as const;

const TASK_STATUSES = ["OPEN", "IN_PROGRESS", "REVIEW", "DONE", "CANCELLED"] as const;

/** One report row, after the positional array has been given its names back. */
export const GridRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  status: Schema.Literal(...TASK_STATUSES),
  priority: Schema.Number,
  updatedAt: Schema.DateTimeUtcFromSelf,
});
export type GridRow = typeof GridRow.Type;

/**
 * The column-oriented report, turned back into records.
 *
 * Rows are positional because in 2009 repeating six key names per row tripled the
 * payload over a leased line. The column list is the contract, so this *checks* it
 * rather than trusting it: if the report server ever reorders or renames a column, the
 * decode fails loudly instead of silently putting a priority into a title.
 */
export const GridReport = Schema.transformOrFail(
  Schema.Struct({
    columns: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Array(Schema.Union(Schema.String, Schema.Number))),
    generatedAt: Schema.Number,
  }),
  Schema.Struct({ rows: Schema.Array(Schema.typeSchema(GridRow)), generatedAt: Schema.DateTimeUtcFromSelf }),
  {
    strict: true,
    decode: (report, _options, ast) => {
      const expected = GRID_COLUMNS.join(",");
      const actual = report.columns.join(",");
      if (expected !== actual) {
        return ParseResult.fail(
          new ParseResult.Type(ast, report, `report columns changed: expected [${expected}] but received [${actual}]`),
        );
      }

      const rows: Array<GridRow> = [];
      for (const row of report.rows) {
        const status = TASK_STATUSES[Number(row[3])];
        if (status === undefined) {
          return ParseResult.fail(new ParseResult.Type(ast, report, `unknown status ordinal ${String(row[3])}`));
        }
        rows.push({
          id: String(row[0]),
          projectId: String(row[1]),
          title: String(row[2]),
          status,
          priority: Number(row[4]),
          updatedAt: DateTime.unsafeMake(Number(row[5])),
        });
      }

      return ParseResult.succeed({ rows, generatedAt: DateTime.unsafeMake(report.generatedAt) });
    },
    encode: (report) =>
      ParseResult.succeed({
        columns: GRID_COLUMNS as unknown as ReadonlyArray<string>,
        rows: report.rows.map((row) => [
          row.id,
          row.projectId,
          row.title,
          TASK_STATUSES.indexOf(row.status),
          row.priority,
          DateTime.toEpochMillis(row.updatedAt),
        ]),
        generatedAt: DateTime.toEpochMillis(report.generatedAt),
      }),
  },
);
export type GridReport = typeof GridReport.Type;

// ---------------------------------------------------------------------------
// POST /api/batch
// ---------------------------------------------------------------------------

export const ProjectRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  owner: Schema.String,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type ProjectRecord = typeof ProjectRecord.Type;

export const StructuredErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

/**
 * One sub-response from the batch endpoint.
 *
 * The batch envelope is always `200`, so the per-item outcome is a field, and the body's
 * shape depends on a *sibling* field rather than on its own contents. A plain
 * `Schema.Union` cannot discriminate on a sibling, so this dispatches explicitly and
 * produces a tagged value the rest of the client can match on — the same
 * `Match.tag`-shaped vocabulary the response envelopes use, one level further in.
 */
export const BatchItem = Schema.transformOrFail(
  Schema.Struct({
    id: Schema.String,
    status: Schema.Number,
    body: Schema.Unknown,
  }),
  Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("found"), id: Schema.String, project: Schema.typeSchema(ProjectRecord) }),
    Schema.Struct({ _tag: Schema.Literal("failed"), id: Schema.String, status: Schema.Number, code: Schema.String, message: Schema.String }),
  ),
  {
    strict: true,
    decode: (item, options, ast) =>
      item.status === 200
        ? ParseResult.decodeUnknown(ProjectRecord)(item.body, options).pipe(
            ParseResult.map((project) => ({ _tag: "found" as const, id: item.id, project })),
            ParseResult.mapError(() => new ParseResult.Type(ast, item, "a 200 item did not carry a project")),
          )
        : ParseResult.decodeUnknown(StructuredErrorBody)(item.body, options).pipe(
            ParseResult.map((error) => ({
              _tag: "failed" as const,
              id: item.id,
              status: item.status,
              code: error.error.code,
              message: error.error.message,
            })),
            ParseResult.mapError(() => new ParseResult.Type(ast, item, "a non-200 item did not carry an error")),
          ),
    encode: (item, options, ast) =>
      item._tag === "found"
        ? ParseResult.encodeUnknown(ProjectRecord)(item.project, options).pipe(
            ParseResult.map((body) => ({ id: item.id, status: 200, body: body as unknown })),
            ParseResult.mapError(() => new ParseResult.Type(ast, item, "could not encode a project")),
          )
        : ParseResult.succeed({
            id: item.id,
            status: item.status,
            body: { error: { code: item.code, message: item.message } } as unknown,
          }),
  },
);
export type BatchItem = typeof BatchItem.Type;

export const BatchResponse = Schema.Struct({ responses: Schema.Array(BatchItem) });
export type BatchResponse = typeof BatchResponse.Type;

export const BatchRequest = Schema.Struct({
  requests: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

// ---------------------------------------------------------------------------
// /api/imports
// ---------------------------------------------------------------------------

export const ImportAccepted = Schema.Struct({ id: Schema.String, state: Schema.Literal("accepted") });

export const ImportStatus = Schema.Union(
  Schema.Struct({ id: Schema.String, state: Schema.Literal("pending"), progress: Schema.Number }),
  Schema.Struct({
    id: Schema.String,
    state: Schema.Literal("done"),
    progress: Schema.Number,
    importedAt: EpochMillis,
  }),
);
export type ImportStatus = typeof ImportStatus.Type;

// ---------------------------------------------------------------------------
// GET /api/lookup
// ---------------------------------------------------------------------------

export const LookupMatches = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});

/** The body that accompanies `X-Error-Code`, on a response that still says `200`. */
export const LookupSyntaxError = taggedBody("LookupSyntaxError", {
  message: Schema.String,
  query: Schema.String,
});
export type LookupSyntaxError = typeof LookupSyntaxError.Type;

// ---------------------------------------------------------------------------
// The Link header
// ---------------------------------------------------------------------------

/**
 * RFC 5988 `Link`, parsed into the pages a caller can actually request.
 *
 * Quirk: the links carry zero-based *offsets* while the endpoint's own query parameter
 * is a one-based *page*. Converting between them is exactly the kind of arithmetic that
 * belongs in one schema rather than in three call sites, and getting it wrong shows up
 * as a quietly skipped or repeated row rather than as an error.
 */
export const LinkHeader = Schema.transform(
  Schema.String,
  Schema.Array(
    Schema.Struct({
      rel: Schema.String,
      uri: Schema.String,
      offset: Schema.Number,
      pageSize: Schema.Number,
      page: Schema.Number,
    }),
  ),
  {
    strict: true,
    decode: (raw) =>
      raw
        .split(/,\s*(?=<)/u)
        .map((part) => {
          const uri = /<([^>]+)>/u.exec(part)?.[1] ?? "";
          const rel = /rel="([^"]+)"/u.exec(part)?.[1] ?? "";
          const parameters = new URL(uri, "http://localhost").searchParams;
          const offset = Number(parameters.get("offset") ?? "0");
          const pageSize = Number(parameters.get("pageSize") ?? "1");
          // The off-by-one, in one place: offsets are zero-based, pages are one-based.
          return { rel, uri, offset, pageSize, page: Math.floor(offset / pageSize) + 1 };
        })
        .filter((link) => link.rel !== ""),
    encode: (links) =>
      links.map((link) => `<${link.uri}>; rel="${link.rel}"`).join(", "),
  },
);
export type LinkHeader = typeof LinkHeader.Type;
