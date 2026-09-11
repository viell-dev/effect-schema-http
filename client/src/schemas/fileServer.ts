import { Schema } from "effect";

export const FILESTORE_NS = "urn:filestore:2011";

/**
 * Quirk: File server dates use .NET US DateTime format: "MM/dd/yyyy HH:mm:ss".
 * A custom Schema transform converts this legacy format to a JavaScript Date.
 */
export const UsDateFromString = Schema.transform(
  Schema.String,
  Schema.DateFromSelf,
  {
    strict: true,
    decode: (str) => {
      // Format: MM/dd/yyyy HH:mm:ss
      const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(str.trim());
      if (!match || !match[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) {
        // Fallback to standard parse if possible
        const fallback = Date.parse(str);
        return Number.isNaN(fallback) ? new Date() : new Date(fallback);
      }
      const month = parseInt(match[1], 10) - 1;
      const day = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);
      const hours = parseInt(match[4], 10);
      const minutes = parseInt(match[5], 10);
      const seconds = parseInt(match[6], 10);
      return new Date(Date.UTC(year, month, day, hours, minutes, seconds));
    },
    encode: (date) => {
      const pad = (n: number) => n.toString().padStart(2, "0");
      const month = pad(date.getUTCMonth() + 1);
      const day = pad(date.getUTCDate());
      const year = date.getUTCFullYear();
      const hours = pad(date.getUTCHours());
      const minutes = pad(date.getUTCMinutes());
      const seconds = pad(date.getUTCSeconds());
      return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
    },
  },
);

/**
 * File metadata item.
 */
export const FileItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contentType: Schema.String,
  size: Schema.Number,
  lastModified: UsDateFromString,
});
export type FileItem = typeof FileItem.Type;

/**
 * Tagged error for SOAP faults.
 * Quirk: The server always responds with HTTP 200; failures are encoded as
 * FaultCode != 0 in the SOAP response body.
 */
export class SoapFaultError extends Schema.TaggedError<SoapFaultError>()(
  "SoapFaultError",
  {
    faultCode: Schema.Number,
    faultString: Schema.String,
  },
) {}

/**
 * Helper to build a standard SOAP request envelope with the urn:filestore:2011 namespace.
 */
export const makeSoapRequestXml = (actionXml: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:fs="${FILESTORE_NS}">
  <soap:Body>
    ${actionXml}
  </soap:Body>
</soap:Envelope>`;

/**
 * Helper to extract tag content from an XML string without heavy DOM dependencies.
 */
const getTagContent = (xml: string, tag: string): string | undefined => {
  const regex = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, "i");
  const match = regex.exec(xml);
  return match ? match[1]?.trim() : undefined;
};

/**
 * Quirk: Parses SOAP envelope, checking FaultCode.
 * If FaultCode !== "0", decodes into SoapFaultError!
 */
export const parseSoapEnvelope = (
  rawXml: string,
): { faultCode: number; faultString: string; bodyXml: string } => {
  const faultCodeStr = getTagContent(rawXml, "FaultCode") ?? "0";
  const faultString = getTagContent(rawXml, "FaultString") ?? "Success";
  const faultCode = parseInt(faultCodeStr, 10) || 0;
  return { faultCode, faultString, bodyXml: rawXml };
};

/**
 * Quirk: ListFiles response handles three shapes:
 * 1. Empty: <Files/> -> []
 * 2. Single file: <Files><Result><File>...</File></Result></Files> (extra Result wrapper)
 * 3. Multiple files: <Files><File>...</File><File>...</File></Files> (no Result wrapper)
 */
export const parseListFilesRaw = (
  xml: string,
): ReadonlyArray<Schema.Schema.Encoded<typeof FileItem>> => {
  const files: Array<Schema.Schema.Encoded<typeof FileItem>> = [];
  const fileRegex = /<(?:[a-zA-Z0-9]+:)?File>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?File>/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(xml)) !== null) {
    const fileSnippet = match[1] ?? "";
    const id = getTagContent(fileSnippet, "FileId") ?? "";
    const name = getTagContent(fileSnippet, "FileName") ?? "";
    const contentType = getTagContent(fileSnippet, "ContentType") ?? "application/octet-stream";
    const size = parseInt(getTagContent(fileSnippet, "FileSize") ?? "0", 10);
    const lastModified = getTagContent(fileSnippet, "LastModified") ?? "01/01/1970 00:00:00";

    files.push({
      id,
      name,
      contentType,
      size,
      lastModified,
    });
  }
  return files;
};

/**
 * Schema transform that decodes raw SOAP XML response for ListFiles into FileItem[].
 */
export const SoapListFilesResponse = Schema.transform(
  Schema.String,
  Schema.Array(FileItem),
  {
    decode: (rawXml) => {
      const envelope = parseSoapEnvelope(rawXml);
      if (envelope.faultCode !== 0) {
        throw new Error(`SOAP Fault [${envelope.faultCode}]: ${envelope.faultString}`);
      }
      return parseListFilesRaw(rawXml);
    },
    encode: () => "<Files/>",
  },
);

/**
 * Schema for UploadFile result.
 */
export const UploadResult = Schema.Struct({
  fileId: Schema.String,
  fileName: Schema.String,
  fileSize: Schema.Number,
});
export type UploadResult = typeof UploadResult.Type;

export const SoapUploadResponse = Schema.transform(
  Schema.String,
  UploadResult,
  {
    strict: true,
    decode: (rawXml) => {
      const envelope = parseSoapEnvelope(rawXml);
      if (envelope.faultCode !== 0) {
        throw new Error(`SOAP Fault [${envelope.faultCode}]: ${envelope.faultString}`);
      }
      const fileId = getTagContent(rawXml, "FileId") ?? "";
      const fileName = getTagContent(rawXml, "FileName") ?? "";
      const fileSize = parseInt(getTagContent(rawXml, "FileSize") ?? "0", 10);
      return { fileId, fileName, fileSize };
    },
    encode: (res) => `<FileId>${res.fileId}</FileId>`,
  },
);
