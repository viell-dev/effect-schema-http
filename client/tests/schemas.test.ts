import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  EpochMsToDate,
  SearchResults,
  TaskStatusFromOrdinal,
} from "../src/schemas/apiServer.js";
import {
  SoapListFilesResponse,
  UsDateFromString,
} from "../src/schemas/fileServer.js";
import {
  NormalizedTokenType,
  parseHttpDateHeader,
} from "../src/schemas/idServer.js";

describe("Schema Quirks & Transforms", () => {
  describe("ID Server Quirks", () => {
    it("normalizes both 'bearer' and 'Bearer' to 'Bearer'", () => {
      const decode = Schema.decodeSync(NormalizedTokenType);
      expect(decode("bearer")).toBe("Bearer");
      expect(decode("Bearer")).toBe("Bearer");
    });

    it("parses HTTP-date header format into seconds and Date", () => {
      const sampleDate = "Fri, 11 Sep 2026 18:00:00 GMT";
      const result = parseHttpDateHeader(sampleDate);
      expect(result).toBeDefined();
      expect(result?.date).toBeInstanceOf(Date);
      expect(result?.date.toUTCString()).toBe(sampleDate);
    });
  });

  describe("File Server Quirks (SOAP)", () => {
    it("transforms .NET US format date 'MM/dd/yyyy HH:mm:ss' to Date and back", () => {
      const raw = "09/11/2026 15:39:54";
      const decoded = Schema.decodeSync(UsDateFromString)(raw);
      expect(decoded).toBeInstanceOf(Date);
      expect(decoded.getUTCFullYear()).toBe(2026);
      expect(decoded.getUTCMonth()).toBe(8); // September (0-indexed)
      expect(decoded.getUTCDate()).toBe(11);
      expect(decoded.getUTCHours()).toBe(15);
      expect(decoded.getUTCMinutes()).toBe(39);
      expect(decoded.getUTCSeconds()).toBe(54);

      const encoded = Schema.encodeSync(UsDateFromString)(decoded);
      expect(encoded).toBe(raw);
    });

    it("parses empty SOAP <Files/> into an empty array", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fs="urn:filestore:2011">
  <soap:Body>
    <fs:Response>
      <fs:FaultCode>0</fs:FaultCode>
      <fs:FaultString>Success</fs:FaultString>
      <fs:Files/>
    </fs:Response>
  </soap:Body>
</soap:Envelope>`;
      const decoded = Schema.decodeSync(SoapListFilesResponse)(xml);
      expect(decoded).toEqual([]);
    });

    it("parses single file with legacy <Result><File> wrapper into 1-element array", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fs="urn:filestore:2011">
  <soap:Body>
    <fs:Response>
      <fs:FaultCode>0</fs:FaultCode>
      <fs:FaultString>Success</fs:FaultString>
      <fs:Files>
        <fs:Result>
          <fs:File>
            <fs:FileId>abc-123</fs:FileId>
            <fs:FileName>single.txt</fs:FileName>
            <fs:ContentType>text/plain</fs:ContentType>
            <fs:FileSize>42</fs:FileSize>
            <fs:LastModified>09/11/2026 15:00:00</fs:LastModified>
          </fs:File>
        </fs:Result>
      </fs:Files>
    </fs:Response>
  </soap:Body>
</soap:Envelope>`;
      const decoded = Schema.decodeSync(SoapListFilesResponse)(xml);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.name).toBe("single.txt");
      expect(decoded[0]?.size).toBe(42);
      expect(decoded[0]?.lastModified).toBeInstanceOf(Date);
    });

    it("parses multiple files <File>...<File> without Result wrapper", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fs="urn:filestore:2011">
  <soap:Body>
    <fs:Response>
      <fs:FaultCode>0</fs:FaultCode>
      <fs:FaultString>Success</fs:FaultString>
      <fs:Files>
        <fs:File>
          <fs:FileId>1</fs:FileId>
          <fs:FileName>f1.txt</fs:FileName>
          <fs:ContentType>text/plain</fs:ContentType>
          <fs:FileSize>10</fs:FileSize>
          <fs:LastModified>09/11/2026 10:00:00</fs:LastModified>
        </fs:File>
        <fs:File>
          <fs:FileId>2</fs:FileId>
          <fs:FileName>f2.txt</fs:FileName>
          <fs:ContentType>text/plain</fs:ContentType>
          <fs:FileSize>20</fs:FileSize>
          <fs:LastModified>09/11/2026 11:00:00</fs:LastModified>
        </fs:File>
      </fs:Files>
    </fs:Response>
  </soap:Body>
</soap:Envelope>`;
      const decoded = Schema.decodeSync(SoapListFilesResponse)(xml);
      expect(decoded).toHaveLength(2);
      expect(decoded[0]?.name).toBe("f1.txt");
      expect(decoded[1]?.name).toBe("f2.txt");
    });
  });

  describe("API Server Quirks", () => {
    it("transforms epoch milliseconds to Date", () => {
      const nowMs = 1789141179128;
      const decoded = Schema.decodeSync(EpochMsToDate)(nowMs);
      expect(decoded).toBeInstanceOf(Date);
      expect(decoded.getTime()).toBe(nowMs);
    });

    it("transforms task status ordinal (0..4) to string enum", () => {
      const decode = Schema.decodeSync(TaskStatusFromOrdinal);
      expect(decode(0)).toBe("OPEN");
      expect(decode(1)).toBe("IN_PROGRESS");
      expect(decode(2)).toBe("REVIEW");
      expect(decode(3)).toBe("DONE");
      expect(decode(4)).toBe("CANCELLED");

      const encode = Schema.encodeSync(TaskStatusFromOrdinal);
      expect(encode("OPEN")).toBe(0);
      expect(encode("DONE")).toBe(3);
    });

    it("normalizes bare unwrapped single search hit into an array", () => {
      const bareObject = {
        type: "project" as const,
        id: "p1",
        name: "Solo Project",
        description: "Only one match",
        updatedAt: 1789141179128,
      };

      const decoded = Schema.decodeSync(SearchResults)(bareObject);
      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.id).toBe("p1");
    });

    it("normalizes array of multiple search hits into an array", () => {
      const multiArray = [
        {
          type: "project" as const,
          id: "p1",
          name: "Project 1",
          description: "Desc 1",
          updatedAt: 1789141179128,
        },
        {
          type: "task" as const,
          id: "t1",
          title: "Task 1",
          description: "Desc 2",
          status: 0,
          updatedAt: 1789141179128,
        },
      ];

      const decoded = Schema.decodeSync(SearchResults)(multiArray);
      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded).toHaveLength(2);
      expect(decoded[0]?.type).toBe("project");
      expect(decoded[1]?.type).toBe("task");
    });
  });
});
