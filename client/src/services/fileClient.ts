import { HttpBody, HttpClientRequest } from "@effect/platform";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import {
  ArchiveMetadata,
  FileBundle,
  FileMetadataFromXml,
  FILESTORE_NS,
  ListFilesResult,
  MultiStatus,
  soapAction,
  soapActionHeader,
  soapEnvelope,
  SoapFaultDocument,
  soapResult,
  UploadReceipt,
  UploadResultFromXml,
} from "../schemas/fileServer.js";
import { getSession } from "../session.js";
import { configure, executionOptions, type Options } from "./options.js";
export const FILE_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_FILE_SERVER_URL) || "http://localhost:4200";

export const fileRequest = (method: string, path: string, options: Options) =>
  Request.make(method, path).pipe(
    Request.baseUrl(FILE_SERVER_URL),
    Request.setHeader("authorization", () => {
      const session = getSession();
      return session === undefined ? undefined : `Bearer ${session.accessToken}`;
    }),
    configure(options),
  );

/** GET /. */
export const getWsdl = (options: Options = {}) =>
  Operation.make(
    fileRequest("GET", "/", {}).pipe(Request.setQuery("wsdl", null), configure(options)),
    Response.status(
      200,
      Body.text.pipe(Body.schema(Schema.String), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** GET /. */
export const getWsdlWithValue = (options: Options = {}) =>
  Operation.make(
    fileRequest("GET", "/", {}).pipe(Request.setQuery("wsdl", ""), configure(options)),
    Response.status(
      200,
      Body.text.pipe(Body.schema(soapResult(Schema.String)), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** PROPFIND /dav/. */
export const propfind = (options: Options = {}) =>
  Operation.make(
    fileRequest("PROPFIND", "/dav/", {}).pipe(Request.setHeader("depth", "1"), configure(options)),
    Response.status(
      207,
      Body.text.pipe(Body.schema(MultiStatus), (decoder) => Response.tag("multiStatus", decoder)),
    ),
    executionOptions(options),
  );

/** POST /upload. */
export const uploadMultipart = (options: Options = {}) =>
  Operation.make(
    fileRequest("POST", "/upload", {}).pipe(
      Request.removeHeader("content-type"),
      configure(options),
      Request.body(Body.encodeSchema(Schema.instanceOf(FormData))(Body.formData)),
    ),
    Response.status(
      201,
      Body.json.pipe(Body.schema(UploadReceipt), (decoder) => Response.tag("created", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          401,
          Body.json.pipe(Body.schema(Schema.Struct({ error: Schema.String })), (decoder) =>
            Response.tag("unauthorized", decoder),
          ),
        ),
      ),
    ),
    executionOptions(options),
  );

/** POST /raw. */
export const uploadRawBytes = (options: Options = {}) =>
  Operation.make(
    fileRequest("POST", "/raw", {}).pipe(configure(options), Request.body(Body.bytes)),
    Response.status(
      201,
      Body.text.pipe(Body.schema(Schema.Trim), (decoder) => Response.tag("created", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          401,
          Body.text.pipe(Body.schema(Schema.String), (decoder) => Response.tag("unauthorized", decoder)),
        ),
      ),
    ),
    executionOptions(options),
  );

/** POST /raw. */
export const uploadRawUnmodelled = (options: Options = {}) =>
  Operation.make(
    fileRequest("POST", "/raw", {}).pipe(configure(options), Request.body(Body.bytes)),
    Response.status(
      200,
      Body.text.pipe(Body.schema(Schema.String), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** GET /bundle. */
export const getBundle = (options: Options = {}) =>
  Operation.make(
    fileRequest("GET", "/bundle", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.formData.pipe(Body.schema(FileBundle), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

const soapFault = Response.status(
  500,
  Body.text.pipe(Body.schema(SoapFaultDocument), (decoder) => Response.tag("SoapFaultStatus", decoder)),
);
const soap = <A, E, R>(
  action: string,
  parameters: Record<string, string>,
  decoder: Body.Decoder<A, E, R>,
  options: Options = {},
  soap12 = false,
) =>
  Operation.make(
    fileRequest("POST", "/", {}).pipe(
      soap12 ? Request.removeHeader("soapaction") : Request.setHeader("soapaction", soapActionHeader(action)),
      configure(options),
      Request.body(
        Body.encoder((value: string) =>
          Effect.succeed(
            HttpBody.text(
              value,
              soap12 ? `application/soap+xml; action="${FILESTORE_NS}/${action}"` : "text/xml; charset=utf-8",
            ),
          ),
        ),
      ),
    ),
    Response.status(
      200,
      decoder.pipe((decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(soapFault)),
    executionOptions(options),
  ).execute({ body: soapEnvelope(soapAction(action, parameters)) });

export const listFiles = (options: Options = {}) =>
  soap("ListFiles", {}, Body.text.pipe(Body.schema(soapResult(ListFilesResult))), options);
export const uploadFile = (fileName: string, contentType: string, base64Data: string, options: Options = {}) =>
  soap(
    "UploadFile",
    { FileName: fileName, ContentType: contentType, FileData: base64Data },
    Body.text.pipe(Body.schema(soapResult(UploadResultFromXml))),
    options,
  );
export const downloadFile = (fileId: string) => soap("DownloadFile", { FileId: fileId }, Body.bytes);
export const getFileMetadata = (fileId: string) =>
  soap("GetFileMetadata", { FileId: fileId }, Body.text.pipe(Body.schema(soapResult(FileMetadataFromXml))));
export const getArchiveMetadata = (fileId: string) =>
  soap("GetFileMetadata", { FileId: fileId }, Body.bytes.pipe(Body.schema(ArchiveMetadata)), {}, true);
export const purgeFiles = () => soap("PurgeFiles", {}, Body.text);

/** Invalid body/method pairing is checked after preparation, before dispatch. */
export const attemptDownloadFileViaGet = (fileId: string) =>
  Operation.make(
    fileRequest("POST", "/", {}).pipe(
      Request.body(Body.text),
      Request.mapEffect((request) => Effect.succeed(HttpClientRequest.setMethod(request, "GET"))),
    ),
    Response.status(
      200,
      Body.bytes.pipe((decoder) => Response.tag("ok", decoder)),
    ),
  ).execute({ body: soapEnvelope(soapAction("DownloadFile", { FileId: fileId })) });
