import { HttpClientRequest } from "@effect/platform";
import { Schema } from "effect";
import {
  createApi,
  RequestBody,
  response,
  ResponseBody,
} from "viell-effect-schema-http";
import {
  makeSoapRequestXml,
  SoapListFilesResponse,
  SoapUploadResponse,
} from "../schemas/fileServer.js";
import { getSession } from "../session.js";

export const FILE_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_FILE_SERVER_URL) ||
  "http://localhost:4200";

/**
 * SOAP File Server API client.
 *
 * Configured with computed Authorization header (Bearer token) and text/xml Content-Type.
 */
export const fileApi = createApi(FILE_SERVER_URL, {
  headers: {
    authorization: () => {
      const session = getSession();
      return session ? `Bearer ${session.accessToken}` : undefined;
    },
    "content-type": "text/xml; charset=utf-8",
  },
});

/**
 * POST / — ListFiles SOAP action.
 * Quirk: Handles three response shapes (empty self-closing, single-in-Result, multiple).
 */
export const listFilesRequest = fileApi.createRequest({
  method: "POST",
  path: "/",
  body: Schema.String,
  bodyCodec: RequestBody.text("text/xml; charset=utf-8"),
  responses: [
    response({ _tag: "ok", status: 200 }, SoapListFilesResponse, {
      codec: ResponseBody.text,
    }),
  ],
});

/**
 * Helper to call ListFiles SOAP action.
 */
export const listFiles = () =>
  listFilesRequest().setBody(makeSoapRequestXml("<fs:ListFiles/>"));

/**
 * POST / — UploadFile SOAP action.
 */
export const uploadFileRequest = fileApi.createRequest({
  method: "POST",
  path: "/",
  body: Schema.String,
  bodyCodec: RequestBody.text("text/xml; charset=utf-8"),
  responses: [
    response({ _tag: "ok", status: 200 }, SoapUploadResponse, {
      codec: ResponseBody.text,
    }),
  ],
});

/**
 * Helper to upload a file to the SOAP File Server.
 */
export const uploadFile = (fileName: string, contentType: string, base64Data: string) => {
  const soapXml = makeSoapRequestXml(`
    <fs:UploadFile>
      <fs:FileName>${fileName}</fs:FileName>
      <fs:ContentType>${contentType}</fs:ContentType>
      <fs:FileData>${base64Data}</fs:FileData>
    </fs:UploadFile>
  `);
  return uploadFileRequest().setBody(soapXml);
};

/**
 * Quirk: DownloadFile requires HTTP GET carrying a SOAP XML body with the FileId!
 * We declare the request as POST (so body is encoded) and use mapRequest to transform
 * the HTTP method to GET before dispatch.
 */
export const downloadFileRequest = fileApi.createRequest({
  method: "POST",
  path: "/",
  body: Schema.String,
  bodyCodec: RequestBody.text("text/xml; charset=utf-8"),
  responses: [
    response({ _tag: "ok", status: 200 }, Schema.Uint8ArrayFromSelf, {
      codec: ResponseBody.uint8Array,
    }),
  ],
});

/**
 * Helper to download a file by fileId via GET with SOAP body.
 */
export const downloadFile = (fileId: string) => {
  const soapXml = makeSoapRequestXml(`
    <fs:DownloadFile>
      <fs:FileId>${fileId}</fs:FileId>
    </fs:DownloadFile>
  `);
  return downloadFileRequest()
    .setBody(soapXml)
    .mapRequest((req) => HttpClientRequest.setMethod(req, "GET"));
};

/**
 * GET /wsdl — Fetch the WSDL document.
 */
export const getWsdl = fileApi.createRequest({
  method: "GET",
  path: "/wsdl",
  responses: [
    response({ _tag: "ok", status: 200 }, Schema.String, {
      codec: ResponseBody.text,
    }),
  ],
});
