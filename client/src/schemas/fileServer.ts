import { DateTime, Effect, ParseResult, Schema } from "effect";

export const FILESTORE_NS = "urn:filestore:2011";

/**
 * Schemas for the Python SOAP service.
 *
 * The service answers `200` to everything and puts the outcome in a `<FaultCode>`
 * element inside the envelope. That is precisely the case the library's response rules
 * are documented as *not* handling — rules match the envelope, and here the envelope is
 * a lie — so the discrimination happens in the schema, which is the intended division of
 * labour rather than a workaround.
 */

// ---------------------------------------------------------------------------
// XML reading, without a DOM
// ---------------------------------------------------------------------------

/** Reads the text of the first `<tag>` element, ignoring any namespace prefix. */
export const tagText = (xml: string, tag: string): string | undefined => {
  const pattern = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${tag}>`, "iu");
  return pattern.exec(xml)?.[1]?.trim();
};

/** Reads the text of every `<tag>` element, in document order. */
export const allTagText = (xml: string, tag: string): ReadonlyArray<string> => {
  const pattern = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${tag}>`, "giu");
  return [...xml.matchAll(pattern)].map((match) => match[1]?.trim() ?? "");
};

/**
 * `.NET`'s default `DateTime.ToString()` on a US-locale server: `MM/dd/yyyy HH:mm:ss`,
 * with no timezone at all.
 *
 * The missing timezone is the real problem — the value is whatever the file server's
 * clock said — and the only defensible reading is "UTC, and do not pretend otherwise".
 * Decoding fails on anything that is not exactly this shape rather than falling back to
 * `Date.parse`, which would accept half the formats in the world and silently shift the
 * value by the reader's own offset.
 */
export const UsDateFromString = Schema.transformOrFail(Schema.String, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (raw, _options, ast) => {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/u.exec(raw.trim());
    if (match === null) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected MM/dd/yyyy HH:mm:ss"));
    }
    const [, month, day, year, hours, minutes, seconds] = match;
    return ParseResult.succeed(DateTime.unsafeMake(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`));
  },
  encode: (value) => {
    const parts = DateTime.toParts(value);
    const pad = (number: number) => number.toString().padStart(2, "0");
    return ParseResult.succeed(
      `${pad(parts.month)}/${pad(parts.day)}/${parts.year} ${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`,
    );
  },
});

// ---------------------------------------------------------------------------
// The fault-inside-a-200 convention
// ---------------------------------------------------------------------------

/** A fault reported inside a `200`, which is how this service reports every failure. */
export const SoapFault = Schema.Struct({
  _tag: Schema.Literal("SoapFault"),
  faultCode: Schema.Number,
  faultString: Schema.String,
});
export type SoapFault = typeof SoapFault.Type;

/**
 * Wraps an XML-parsing schema so a non-zero `<FaultCode>` becomes a tagged value rather
 * than a decode failure.
 *
 * A fault is not malformed — it is one of the two things this service says, and the
 * client has to render it. Making it a union member keeps it in the success channel
 * where `Match.tag` can reach it, and keeps genuine parse failures meaning what they
 * say. Every action reuses this, so "check the fault code" exists once.
 */
export const soapResult = <A, R>(inner: Schema.Schema<A, string, R>) =>
  Schema.transformOrFail(
    Schema.String,
    Schema.Union(Schema.Struct({ _tag: Schema.Literal("ok"), value: Schema.typeSchema(inner) }), SoapFault),
    {
      strict: false,
      decode: (xml, options) => {
        const faultCode = Number(tagText(xml, "FaultCode") ?? "0");
        if (Number.isFinite(faultCode) && faultCode !== 0) {
          return ParseResult.succeed({
            _tag: "SoapFault" as const,
            faultCode,
            faultString: tagText(xml, "FaultString") ?? "unspecified fault",
          });
        }
        return ParseResult.map(ParseResult.decodeUnknown(inner)(xml, options), (value) => ({
          _tag: "ok" as const,
          value,
        }));
      },
      encode: (result, options) =>
        result._tag === "SoapFault"
          ? ParseResult.succeed(
              `<FaultCode>${result.faultCode}</FaultCode><FaultString>${result.faultString}</FaultString>`,
            )
          : ParseResult.encodeUnknown(inner)(result.value as A, options),
    },
  );

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const FileItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contentType: Schema.String,
  size: Schema.Number,
  lastModified: UsDateFromString,
});
export type FileItem = typeof FileItem.Type;

const fileItemFromXml = (snippet: string): Schema.Schema.Encoded<typeof FileItem> => ({
  id: tagText(snippet, "FileId") ?? "",
  name: tagText(snippet, "FileName") ?? "",
  contentType: tagText(snippet, "ContentType") ?? "application/octet-stream",
  size: Number(tagText(snippet, "FileSize") ?? "0"),
  lastModified: tagText(snippet, "LastModified") ?? "01/01/1970 00:00:00",
});

/**
 * `ListFiles`, across the three shapes the .NET serializer used to emit.
 *
 * Empty is `<Files/>`, several are `<Files><File>…</File><File>…</File></Files>`, and
 * exactly one is wrapped in an extra `<Result>` — a serializer bug in the original that
 * the ERP integration came to depend on, so the Python port reproduces it deliberately.
 * Reading every `<File>` element wherever it sits normalizes all three without caring
 * which one arrived.
 */
export const ListFilesResult = Schema.transform(Schema.String, Schema.Array(FileItem), {
  strict: true,
  decode: (xml) =>
    [...xml.matchAll(/<(?:[A-Za-z0-9]+:)?File>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?File>/giu)].map((match) =>
      fileItemFromXml(match[1] ?? ""),
    ),
  encode: (items) =>
    items.length === 0
      ? "<Files/>"
      : `<Files>${items
          .map(
            (item) =>
              `<File><FileId>${item.id}</FileId><FileName>${item.name}</FileName>` +
              `<ContentType>${item.contentType}</ContentType><FileSize>${item.size}</FileSize>` +
              `<LastModified>${item.lastModified}</LastModified></File>`,
          )
          .join("")}</Files>`,
});

export const UploadResult = Schema.Struct({
  fileId: Schema.String,
  fileName: Schema.String,
  fileSize: Schema.Number,
});
export type UploadResult = typeof UploadResult.Type;

export const UploadResultFromXml = Schema.transform(Schema.String, UploadResult, {
  strict: true,
  decode: (xml) => ({
    fileId: tagText(xml, "FileId") ?? "",
    fileName: tagText(xml, "FileName") ?? "",
    fileSize: Number(tagText(xml, "FileSize") ?? "0"),
  }),
  encode: (result) =>
    `<UploadFileResult><FileId>${result.fileId}</FileId><FileName>${result.fileName}</FileName>` +
    `<FileSize>${result.fileSize}</FileSize></UploadFileResult>`,
});

export const FileMetadataFromXml = Schema.transform(Schema.String, FileItem, {
  strict: true,
  decode: (xml) => fileItemFromXml(xml),
  encode: (item) =>
    `<GetFileMetadataResult><FileId>${item.id}</FileId><FileName>${item.name}</FileName>` +
    `<ContentType>${item.contentType}</ContentType><FileSize>${item.size}</FileSize>` +
    `<LastModified>${item.lastModified}</LastModified></GetFileMetadataResult>`,
});

// ---------------------------------------------------------------------------
// Building requests
// ---------------------------------------------------------------------------

const escapeXml = (value: string): string =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

/** Wraps an action element in the envelope, with the namespace the 2011 service declared. */
export const soapEnvelope = (actionXml: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fs="${FILESTORE_NS}">
  <soap:Body>
${actionXml}
  </soap:Body>
</soap:Envelope>`;

/** Builds one `<fs:Action>` element with escaped child values. */
export const soapAction = (action: string, fields: Readonly<Record<string, string>> = {}): string => {
  const children = Object.entries(fields)
    .map(([name, value]) => `      <fs:${name}>${escapeXml(value)}</fs:${name}>`)
    .join("\n");
  return children === ""
    ? `    <fs:${action}/>`
    : `    <fs:${action}>\n${children}\n    </fs:${action}>`;
};

/** The quoted `SOAPAction` header value the ESB routes on. */
export const soapActionHeader = (action: string): string => `"${FILESTORE_NS}/${action}"`;

// ---------------------------------------------------------------------------
// The one action that answers a real fault with a real status
// ---------------------------------------------------------------------------

/** A SOAP 1.1 fault document, as `PurgeFiles` answers it with HTTP 500. */
export const SoapFaultDocument = Schema.transform(
  Schema.String,
  Schema.Struct({ faultcode: Schema.String, faultstring: Schema.String, reason: Schema.String }),
  {
    strict: true,
    decode: (xml) => ({
      faultcode: tagText(xml, "faultcode") ?? "",
      faultstring: tagText(xml, "faultstring") ?? "",
      reason: tagText(xml, "Reason") ?? "",
    }),
    encode: (fault) =>
      `<soap:Fault><faultcode>${fault.faultcode}</faultcode><faultstring>${fault.faultstring}</faultstring></soap:Fault>`,
  },
);

// ---------------------------------------------------------------------------
// Bytes that are text in an encoding nobody declared properly
// ---------------------------------------------------------------------------

/**
 * Decodes an XML document using the encoding its own declaration names.
 *
 * The archive's metadata documents are ISO-8859-1 and say so in the XML declaration,
 * but the HTTP `Content-Type` is a bare `text/xml` with no charset. Under RFC 2616 that
 * meant Latin-1 and everything worked; RFC 7231 removed the default, and every modern
 * client — including `Response.text()`, which this library's `ResponseBody.text` uses —
 * now assumes UTF-8 and turns `Renée` into `Ren�e`.
 *
 * The fix is to take the bytes instead and let the document say what it is. That means
 * `ResponseBody.uint8Array` and a schema that starts from `Schema.Uint8ArrayFromSelf`,
 * which is the pairing the library documents for exactly this: the codec hands over
 * bytes and the parsing stays in the schema.
 */
export const XmlFromBytes = Schema.transformOrFail(Schema.Uint8ArrayFromSelf, Schema.String, {
  strict: true,
  decode: (bytes, _options, ast) => {
    // The declaration is ASCII-compatible in every encoding this service uses, so it can
    // be read before the encoding is known.
    const preamble = new TextDecoder("ascii").decode(bytes.slice(0, 120));
    const declared = /encoding=["']([^"']+)["']/iu.exec(preamble)?.[1] ?? "utf-8";
    try {
      return ParseResult.succeed(new TextDecoder(declared, { fatal: true }).decode(bytes));
    } catch (cause) {
      return ParseResult.fail(new ParseResult.Type(ast, bytes, `cannot decode ${declared}: ${String(cause)}`));
    }
  },
  encode: (text) => ParseResult.succeed(new TextEncoder().encode(text)),
});

/** The archive metadata document, once its bytes have been read in the right encoding. */
export const ArchiveMetadata = Schema.compose(
  XmlFromBytes,
  Schema.transform(
    Schema.String,
    Schema.Struct({
      fileId: Schema.String,
      fileName: Schema.String,
      archivist: Schema.String,
      department: Schema.String,
      lastModified: UsDateFromString,
    }),
    {
      strict: true,
      decode: (xml) => ({
        fileId: tagText(xml, "FileId") ?? "",
        fileName: tagText(xml, "FileName") ?? "",
        archivist: tagText(xml, "Archivist") ?? "",
        department: tagText(xml, "Department") ?? "",
        lastModified: tagText(xml, "LastModified") ?? "01/01/1970 00:00:00",
      }),
      encode: (metadata) =>
        `<?xml version="1.0" encoding="ISO-8859-1"?><FileMetadata><FileId>${metadata.fileId}</FileId>` +
        `<FileName>${metadata.fileName}</FileName><Archivist>${metadata.archivist}</Archivist>` +
        `<Department>${metadata.department}</Department><LastModified>${metadata.lastModified}</LastModified></FileMetadata>`,
    },
  ),
  { strict: false },
);
export type ArchiveMetadata = typeof ArchiveMetadata.Type;

// ---------------------------------------------------------------------------
// WebDAV
// ---------------------------------------------------------------------------

/** One resource from a `207 Multi-Status` document. */
export const DavResource = Schema.Struct({
  href: Schema.String,
  displayName: Schema.String,
  contentLength: Schema.Number,
  contentType: Schema.String,
});

/**
 * `PROPFIND`'s multistatus document.
 *
 * Every `<D:response>` carries its own status line as text, which is the whole idea of
 * `207`: the transport succeeded and each member reports separately. Collection entries
 * have no `getcontentlength`, so they are skipped rather than decoded as zero-byte files.
 */
export const MultiStatus = Schema.transform(Schema.String, Schema.Array(DavResource), {
  strict: true,
  decode: (xml) =>
    [...xml.matchAll(/<D:response>([\s\S]*?)<\/D:response>/giu)]
      .map((match) => match[1] ?? "")
      .filter((entry) => tagText(entry, "getcontentlength") !== undefined)
      .map((entry) => ({
        href: tagText(entry, "href") ?? "",
        displayName: tagText(entry, "displayname") ?? "",
        contentLength: Number(tagText(entry, "getcontentlength") ?? "0"),
        contentType: tagText(entry, "getcontenttype") ?? "application/octet-stream",
      })),
  encode: (resources) =>
    `<D:multistatus xmlns:D="DAV:">${resources
      .map(
        (resource) =>
          `<D:response><D:href>${resource.href}</D:href><D:propstat><D:prop>` +
          `<D:displayname>${resource.displayName}</D:displayname>` +
          `<D:getcontentlength>${resource.contentLength}</D:getcontentlength>` +
          `<D:getcontenttype>${resource.contentType}</D:getcontenttype>` +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      )
      .join("")}</D:multistatus>`,
});

// ---------------------------------------------------------------------------
// Multipart, in both directions
// ---------------------------------------------------------------------------

/** The JSON receipt the 2019 multipart endpoint answers with. */
export const UploadReceipt = Schema.Struct({
  fileId: Schema.String,
  fileName: Schema.String,
  sizeBytes: Schema.Number,
  uploadedAt: Schema.DateTimeUtc,
});
export type UploadReceipt = typeof UploadReceipt.Type;

/**
 * A bundle response: metadata and bytes in one `multipart/form-data` payload.
 *
 * `ResponseBody.formData` hands over a real `FormData`, and reading a part's bytes out
 * of it is asynchronous — `Blob.arrayBuffer()` returns a promise. An Effect Schema
 * transform can be effectful, so the await belongs inside the schema rather than in a
 * second step after decoding, and the endpoint still yields one finished value.
 */
export const FileBundle = Schema.transformOrFail(
  Schema.instanceOf(FormData),
  Schema.Struct({
    metadata: Schema.Struct({
      fileId: Schema.String,
      fileName: Schema.String,
      sizeBytes: Schema.Number,
      lastModified: UsDateFromString,
    }),
    content: Schema.Uint8ArrayFromSelf,
  }),
  {
    strict: false,
    decode: (form, options, ast) => {
      const metadataPart = form.get("metadata");
      const contentPart = form.get("content");
      if (metadataPart === null || contentPart === null) {
        return ParseResult.fail(new ParseResult.Type(ast, form, "expected metadata and content parts"));
      }

      const readMetadata =
        typeof metadataPart === "string"
          ? Effect.succeed(metadataPart)
          : Effect.promise(() => metadataPart.text());
      const readContent =
        typeof contentPart === "string"
          ? Effect.succeed(new TextEncoder().encode(contentPart))
          : Effect.promise(async () => new Uint8Array(await contentPart.arrayBuffer()));

      return Effect.flatMap(Effect.all([readMetadata, readContent]), ([metadataText, content]) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(metadataText);
        } catch {
          return ParseResult.fail(new ParseResult.Type(ast, form, "the metadata part is not JSON"));
        }
        return ParseResult.map(
          ParseResult.decodeUnknown(
            Schema.Struct({
              fileId: Schema.String,
              fileName: Schema.String,
              sizeBytes: Schema.Number,
              lastModified: Schema.String,
            }),
          )(parsed, options),
          (metadata) => ({ metadata: { ...metadata, lastModified: metadata.lastModified }, content }),
        );
      });
    },
    encode: (bundle, _options, ast) =>
      ParseResult.fail(new ParseResult.Type(ast, bundle, "a bundle is read, never sent")),
  },
);
export type FileBundle = typeof FileBundle.Type;
