import { DateTime, Either, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AspNetDate,
  CreditLimit,
  CustomerRef,
  GridReport,
  LinkHeader,
  MysqlNullableDate,
  UsdFromDisplay,
} from "../src/schemas/apiLegacy.js";
import {
  BlankAsNull,
  HttpDate,
  LdapGeneralizedTime,
  RetryAfterSeconds,
  SpaceDelimited,
  taggedBody,
  YesNo,
} from "../src/schemas/common.js";
import {
  ArchiveMetadata,
  ListFilesResult,
  MultiStatus,
  soapResult,
  UsDateFromString,
  XmlFromBytes,
} from "../src/schemas/fileServer.js";
import { BearerTokenType } from "../src/schemas/idLegacy.js";
import { SearchResults, TaskStatusFromOrdinal } from "../src/schemas/apiServer.js";

/**
 * Unit tests for the reconciliation layer.
 *
 * These need no servers: each one pins a single wire convention and, where the
 * transform is bidirectional, that it survives a round trip. A transform that only
 * decodes is a mapping function wearing a schema's clothes; the ones here that claim to
 * encode are tested for it, because the cross-service work in `integration.test.ts`
 * depends on running them backwards.
 */

describe("conventions more than one service invented independently", () => {
  it("splits a space-delimited list and puts it back", () => {
    const scopes = Schema.decodeSync(SpaceDelimited(Schema.String))("openid profile projects:read");
    expect(scopes).toEqual(["openid", "profile", "projects:read"]);
    expect(Schema.encodeSync(SpaceDelimited(Schema.String))(scopes)).toBe("openid profile projects:read");
  });

  it("reads Y and N as booleans and refuses anything else", () => {
    expect(Schema.decodeSync(YesNo)("Y")).toBe(true);
    expect(Schema.decodeSync(YesNo)("N")).toBe(false);
    expect(Schema.encodeSync(YesNo)(true)).toBe("Y");
    // "y", "1" and "true" are not this format, and guessing is how a disabled account
    // becomes an enabled one.
    expect(Either.isLeft(Schema.decodeUnknownEither(YesNo)("y"))).toBe(true);
  });

  it("round-trips LDAP generalized time", () => {
    const decoded = Schema.decodeSync(LdapGeneralizedTime)("20260911162242Z");
    expect(DateTime.formatIso(decoded)).toBe("2026-09-11T16:22:42.000Z");
    expect(Schema.encodeSync(LdapGeneralizedTime)(decoded)).toBe("20260911162242Z");
    expect(Either.isLeft(Schema.decodeUnknownEither(LdapGeneralizedTime)("2026-09-11"))).toBe(true);
  });

  it("treats a blank string as absent", () => {
    const schema = BlankAsNull(Schema.String);
    expect(Schema.decodeSync(schema)("")).toBeNull();
    expect(Schema.decodeSync(schema)("   ")).toBeNull();
    expect(Schema.decodeSync(schema)("value")).toBe("value");
    expect(Schema.encodeSync(schema)(null)).toBe("");
  });

  it("accepts both forms of Retry-After and reports seconds", () => {
    expect(Schema.decodeSync(RetryAfterSeconds)("120")).toBe(120);
    const soon = new Date(Date.now() + 30_000).toUTCString();
    expect(Schema.decodeSync(RetryAfterSeconds)(soon)).toBeGreaterThan(25);
    expect(Either.isLeft(Schema.decodeUnknownEither(HttpDate)("120"))).toBe(true);
  });

  it("attaches a discriminant the service never sent, and strips it again", () => {
    const Error = taggedBody("OAuthError", { error: Schema.String });
    const decoded = Schema.decodeUnknownSync(Error)({ error: "invalid_grant" });
    expect(decoded._tag).toBe("OAuthError");
    // The encoded form is what the service actually understands: no tag.
    expect(Schema.encodeSync(Error)(decoded)).toEqual({ error: "invalid_grant" });
  });
});

describe("the ID server's spellings", () => {
  it("accepts three casings of bearer and refuses a fourth scheme", () => {
    expect(Schema.decodeSync(BearerTokenType)("bearer")).toBe("Bearer");
    expect(Schema.decodeSync(BearerTokenType)("Bearer")).toBe("Bearer");
    expect(Schema.decodeSync(BearerTokenType)("BEARER")).toBe("Bearer");
    // Normalizing an unknown scheme to Bearer would attach a credential in a form the
    // server never agreed to.
    expect(Either.isLeft(Schema.decodeUnknownEither(BearerTokenType)("MAC"))).toBe(true);
  });
});

describe("the Java service's older conventions", () => {
  it("reads ASP.NET dates, offset and all", () => {
    expect(DateTime.toEpochMillis(Schema.decodeSync(AspNetDate)("/Date(1262304000000)/"))).toBe(1262304000000);
    // The offset is decorative; the value before it is already UTC.
    expect(DateTime.toEpochMillis(Schema.decodeSync(AspNetDate)("/Date(1262304000000+0100)/"))).toBe(1262304000000);
    expect(Either.isLeft(Schema.decodeUnknownEither(AspNetDate)("2010-01-01"))).toBe(true);
  });

  it("reads the MySQL zero date as no date", () => {
    expect(Schema.decodeSync(MysqlNullableDate)("0000-00-00")).toBeNull();
    expect(Schema.encodeSync(MysqlNullableDate)(null)).toBe("0000-00-00");
    expect(DateTime.formatIso(Schema.decodeSync(MysqlNullableDate)("2019-04-02")!)).toBe("2019-04-02T00:00:00.000Z");
  });

  it("keeps money as integer cents in both directions", () => {
    expect(Schema.decodeSync(UsdFromDisplay)("$1,234.50")).toBe(123450);
    expect(Schema.decodeSync(UsdFromDisplay)("$0.07")).toBe(7);
    expect(Schema.encodeSync(UsdFromDisplay)(1234567 as never)).toBe("$12,345.67");
    expect(Either.isLeft(Schema.decodeUnknownEither(UsdFromDisplay)("1234.50"))).toBe(true);
  });

  it("distinguishes no limit from a limit of zero", () => {
    expect(Schema.decodeSync(CreditLimit)(-1)).toEqual({ _tag: "unlimited" });
    expect(Schema.decodeSync(CreditLimit)(0)).toEqual({ _tag: "limited", amount: 0 });
    expect(Schema.encodeSync(CreditLimit)({ _tag: "unlimited" })).toBe(-1);
  });

  it("normalizes a reference that is sometimes an object", () => {
    expect(Schema.decodeUnknownSync(CustomerRef)("CUST-1")).toEqual({ id: "CUST-1", name: null });
    expect(Schema.decodeUnknownSync(CustomerRef)({ id: "CUST-1", name: "Contoso" })).toEqual({
      id: "CUST-1",
      name: "Contoso",
    });
    expect(Schema.encodeSync(CustomerRef)({ id: "CUST-1", name: null })).toBe("CUST-1");
  });

  it("refuses a report whose columns moved", () => {
    const good = {
      columns: ["id", "projectId", "title", "status", "priority", "updatedAt"],
      rows: [["t-1", "p-1", "Title", 2, 5, 1262304000000]],
      generatedAt: 1262304000000,
    };
    const decoded = Schema.decodeUnknownSync(GridReport)(good);
    expect(decoded.rows[0]?.status).toBe("REVIEW");

    const reordered = { ...good, columns: ["id", "projectId", "status", "title", "priority", "updatedAt"] };
    const result = Schema.decodeUnknownEither(GridReport)(reordered);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("converts the Link header's offsets into pages", () => {
    const links = Schema.decodeSync(LinkHeader)(
      '<http://localhost:4300/api/projects?offset=4&pageSize=2>; rel="next", ' +
        '<http://localhost:4300/api/projects?offset=0&pageSize=2>; rel="first"',
    );
    expect(links).toHaveLength(2);
    // offset 4 with a page size of 2 is the third page, one-based.
    expect(links.find((link) => link.rel === "next")?.page).toBe(3);
    expect(links.find((link) => link.rel === "first")?.page).toBe(1);
  });

  it("normalizes a single search hit that was not wrapped in an array", () => {
    const single = Schema.decodeUnknownSync(SearchResults)({
      type: "project",
      id: "p-1",
      name: "Alpha",
      description: "",
      updatedAt: 1262304000000,
    });
    expect(single).toHaveLength(1);
    const several = Schema.decodeUnknownSync(SearchResults)([]);
    expect(several).toHaveLength(0);
  });

  it("maps a status ordinal to the name a request has to send", () => {
    expect(Schema.decodeSync(TaskStatusFromOrdinal)(0)).toBe("OPEN");
    expect(Schema.decodeSync(TaskStatusFromOrdinal)(4)).toBe("CANCELLED");
    expect(Schema.encodeSync(TaskStatusFromOrdinal)("REVIEW")).toBe(2);
  });
});

describe("the SOAP service's documents", () => {
  const envelope = (inner: string, faultCode = 0, faultString = "Success") => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fs="urn:filestore:2011">
  <soap:Body><fs:Response>
    <fs:FaultCode>${faultCode}</fs:FaultCode>
    <fs:FaultString>${faultString}</fs:FaultString>
    ${inner}
  </fs:Response></soap:Body>
</soap:Envelope>`;

  const file = (id: string) =>
    `<fs:File><fs:FileId>${id}</fs:FileId><fs:FileName>${id}.txt</fs:FileName>` +
    `<fs:ContentType>text/plain</fs:ContentType><fs:FileSize>3</fs:FileSize>` +
    `<fs:LastModified>09/11/2026 15:39:54</fs:LastModified></fs:File>`;

  it("reads the same list out of all three shapes the serializer emits", () => {
    const decode = Schema.decodeSync(ListFilesResult);
    expect(decode(envelope("<fs:Files/>"))).toHaveLength(0);
    // The single-file case carries an extra <Result> wrapper, reproduced from a .NET
    // serializer bug the ERP integration came to depend on.
    expect(decode(envelope(`<fs:Files><fs:Result>${file("a")}</fs:Result></fs:Files>`))).toHaveLength(1);
    expect(decode(envelope(`<fs:Files>${file("a")}${file("b")}</fs:Files>`))).toHaveLength(2);
  });

  it("turns a non-zero fault code inside a 200 into a tagged value, not a failure", () => {
    const decode = Schema.decodeSync(soapResult(ListFilesResult));
    const ok = decode(envelope(`<fs:Files>${file("a")}</fs:Files>`));
    expect(ok._tag).toBe("ok");

    const fault = decode(envelope("<fs:Files/>", 6, "Authorization required"));
    expect(fault).toEqual({ _tag: "SoapFault", faultCode: 6, faultString: "Authorization required" });
  });

  it("round-trips the .NET US date and refuses anything looser", () => {
    const raw = "09/11/2026 15:39:54";
    const decoded = Schema.decodeSync(UsDateFromString)(raw);
    expect(DateTime.formatIso(decoded)).toBe("2026-09-11T15:39:54.000Z");
    expect(Schema.encodeSync(UsDateFromString)(decoded)).toBe(raw);
    // Date.parse would happily accept this and shift it by the reader's own offset.
    expect(Either.isLeft(Schema.decodeUnknownEither(UsDateFromString)("2026-09-11T15:39:54Z"))).toBe(true);
  });

  it("decodes a document using the encoding its own declaration names", () => {
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><FileMetadata><Archivist>Ren'),
      0xe9,
      ...new TextEncoder().encode("e</Archivist></FileMetadata>"),
    ]);

    // The bytes as text, decoded correctly.
    expect(Schema.decodeSync(XmlFromBytes)(latin1)).toContain("Renée");
    // What `Body.text` would have produced: 0xE9 is not valid UTF-8.
    expect(new TextDecoder().decode(latin1)).toContain("Ren�e");
  });

  it("reads an archive document end to end from its bytes", () => {
    const document =
      '<?xml version="1.0" encoding="ISO-8859-1"?><FileMetadata>' +
      "<FileId>f-1</FileId><FileName>Rapport.txt</FileName><Archivist>Renée Müller</Archivist>" +
      "<Department>Bücherei</Department><LastModified>09/11/2026 15:39:54</LastModified></FileMetadata>";
    const bytes = Uint8Array.from([...document].map((character) => character.charCodeAt(0)));

    const decoded = Schema.decodeSync(ArchiveMetadata)(bytes);
    expect(decoded.archivist).toBe("Renée Müller");
    expect(decoded.department).toBe("Bücherei");
    expect(DateTime.formatIso(decoded.lastModified)).toBe("2026-09-11T15:39:54.000Z");
  });

  it("skips collections when reading a multistatus document", () => {
    const resources = Schema.decodeSync(MultiStatus)(`<D:multistatus xmlns:D="DAV:">
      <D:response><D:href>/dav/</D:href><D:propstat><D:prop>
        <D:displayname>filestore</D:displayname><D:resourcetype><D:collection/></D:resourcetype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/dav/f-1</D:href><D:propstat><D:prop>
        <D:displayname>Rapport.txt</D:displayname><D:getcontentlength>12</D:getcontentlength>
        <D:getcontenttype>text/plain</D:getcontenttype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`);

    expect(resources).toHaveLength(1);
    expect(resources[0]?.displayName).toBe("Rapport.txt");
  });
});

describe("absence, as four different services spell it", () => {
  it("collapses null, empty, the string null, and a missing key", async () => {
    const { AbsentFourWays } = await import("../src/schemas/apiLegacy.js");
    const decode = Schema.decodeUnknownSync(AbsentFourWays);
    expect(Option.isNone(decode(null))).toBe(true);
    expect(Option.isNone(decode(""))).toBe(true);
    expect(Option.isNone(decode("null"))).toBe(true);
    expect(Option.getOrNull(decode("a note"))).toBe("a note");
  });
});
