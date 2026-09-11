import { HttpClientRequest } from "@effect/platform";
import { Schema } from "effect";
import { createApi, mapEndpoint, RequestBody, response, ResponseBody } from "viell-effect-schema-http";
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

export const FILE_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_FILE_SERVER_URL) || "http://localhost:4200";

/**
 * The Python SOAP service.
 *
 * One computed `authorization` header for the whole API, and a `content-type` that is
 * right for every SOAP 1.1 action. Everything else differs per action, which is what
 * `mapEndpoint` is for below.
 */
export const fileApi = createApi(FILE_SERVER_URL, {
  headers: {
    authorization: () => {
      const session = getSession();
      return session === undefined ? undefined : `Bearer ${session.accessToken}`;
    },
  },
});

/**
 * A declared `content-type` header would be pointless on this API.
 *
 * Request body encoding runs after the declarative layer is materialized, and every
 * codec that carries a media type sets one: `RequestBody.text()` defaults to
 * `text/plain` and overwrites whatever was declared, `RequestBody.formData` removes the
 * header entirely so the boundary can be generated. The content type for a body-bearing
 * request therefore belongs to the **codec**, not to the header list — which is why
 * `RequestBody.text` takes it as an argument.
 *
 * That is the right design and it is not obvious, so the SOAP 1.2 action below changes
 * the codec rather than the header.
 */
const SOAP_11_CONTENT_TYPE = "text/xml; charset=utf-8";
const soap12ContentType = (action: string) => `application/soap+xml; action="${FILESTORE_NS}/${action}"`;

/**
 * The shape every SOAP 1.1 action shares: `POST /`, an XML envelope in, an XML envelope
 * out at `200`, and — for the one action written by someone who had read the
 * specification — a real `soap:Fault` at `500`.
 *
 * Declaring it once and deriving the actions from it with `mapEndpoint` is the only way
 * to express "same endpoint, different body and response schema" as a reusable thing:
 * supplying a body and replacing a response schema both change the plan's type
 * parameters, so `RequestPlanTransform` cannot describe them.
 */
const soapCall = fileApi.createRequest({
  method: "POST",
  path: "/",
  body: Schema.String,
  bodyCodec: RequestBody.text(SOAP_11_CONTENT_TYPE),
  responses: [
    response({ _tag: "ok", status: 200 }, Schema.String, { codec: ResponseBody.text }),
    response({ _tag: "SoapFaultStatus", status: 500 }, SoapFaultDocument, { codec: ResponseBody.text }),
  ] as const,
});

/**
 * `ListFiles` — one action, fully configured, callable with no arguments.
 *
 * The response schema is `soapResult(...)`, so a non-zero `<FaultCode>` inside the `200`
 * arrives as a tagged union member rather than as a decode failure. The transport says
 * "fine" either way; only the body knows.
 */
export const listFiles = soapCall.pipe(
  mapEndpoint((plan) =>
    plan
      .setHeader("soapaction", soapActionHeader("ListFiles"))
      .setBody(soapEnvelope(soapAction("ListFiles")))
      .setResponseSchema({ _tag: "ok", status: 200 }, soapResult(ListFilesResult), { codec: ResponseBody.text }),
  ),
);

/** `UploadFile` — base64 in an XML element, which is how the WCF service did it. */
export const uploadFile = (fileName: string, contentType: string, base64Data: string) =>
  soapCall()
    .setHeader("soapaction", soapActionHeader("UploadFile"))
    .setBody(soapEnvelope(soapAction("UploadFile", { FileName: fileName, ContentType: contentType, FileData: base64Data })))
    .setResponseSchema({ _tag: "ok", status: 200 }, soapResult(UploadResultFromXml), { codec: ResponseBody.text });

/**
 * `DownloadFile` — the bytes come back raw, not wrapped in an envelope.
 *
 * The same action can therefore answer with two entirely different media types: file
 * bytes when the id exists, and a SOAP envelope reporting a fault when it does not. The
 * two rules are separated by a `content-type` matcher, which is exactly what response
 * rules are for — the distinguishing fact is in the envelope and is known before the
 * body is read.
 */
export const downloadFile = (fileId: string) =>
  soapCall()
    .setHeader("soapaction", soapActionHeader("DownloadFile"))
    .setBody(soapEnvelope(soapAction("DownloadFile", { FileId: fileId })))
    .setResponseSchema(
      { _tag: "ok", status: 200 },
      Schema.Uint8ArrayFromSelf,
      { codec: ResponseBody.uint8Array },
    );

/** `GetFileMetadata` over SOAP 1.1, which answers the ordinary envelope. */
export const getFileMetadata = (fileId: string) =>
  soapCall()
    .setHeader("soapaction", soapActionHeader("GetFileMetadata"))
    .setBody(soapEnvelope(soapAction("GetFileMetadata", { FileId: fileId })))
    .setResponseSchema({ _tag: "ok", status: 200 }, soapResult(FileMetadataFromXml), { codec: ResponseBody.text });

/**
 * The same action over SOAP 1.2, which answers the archive's ISO-8859-1 document.
 *
 * SOAP 1.2 carries the action inside the content type and forbids the `SOAPAction`
 * header, so this removes the header the 1.1 actions set. The response is read as
 * **bytes**: its `Content-Type` is a bare `text/xml` with no charset, so
 * `ResponseBody.text` would decode it as UTF-8 and replace every accented character.
 */
export const getArchiveMetadata = (fileId: string) =>
  soapCall()
    // SOAP 1.2 forbids the SOAPAction header and carries the action in the content type
    // instead, which means changing the codec rather than setting a header.
    .removeHeader("soapaction")
    .setRequestBodyCodec(RequestBody.text(soap12ContentType("GetFileMetadata")))
    .setBody(soapEnvelope(soapAction("GetFileMetadata", { FileId: fileId })))
    .setResponseSchema({ _tag: "ok", status: 200 }, ArchiveMetadata, { codec: ResponseBody.uint8Array });

/**
 * `PurgeFiles` — the one action that answers a real fault with a real status.
 *
 * Its `500` is a declared rule, so it is an ordinary typed value rather than a transport
 * error, and the call site handles it in the same `Match` chain as everything else.
 */
export const purgeFiles = soapCall.pipe(
  mapEndpoint((plan) =>
    plan.setHeader("soapaction", soapActionHeader("PurgeFiles")).setBody(soapEnvelope(soapAction("PurgeFiles"))),
  ),
);

/**
 * `GET /?wsdl` — the contract, requested the way every SOAP toolkit requests it.
 *
 * The bare key matters: this service answers the contract for `?wsdl` and a fault for
 * `?wsdl=`, which is a distinction the original .NET stack also made. The library
 * distinguishes them at the type level — `true` produces `?wsdl` and `""` produces
 * `?wsdl=` — so the correct request is expressible without string-building a URL.
 */
export const getWsdl = fileApi.createRequest({
  method: "GET",
  path: "/",
  urlParams: { wsdl: true },
  responses: [response({ _tag: "ok", status: 200 }, Schema.String, { codec: ResponseBody.text })],
});

/** The same request with a value instead of a bare key, which this service refuses. */
export const getWsdlWithValue = fileApi.createRequest({
  method: "GET",
  path: "/",
  urlParams: { wsdl: "" },
  responses: [
    response({ _tag: "ok", status: 200 }, soapResult(Schema.String), { codec: ResponseBody.text }),
  ],
});

/**
 * `PROPFIND /dav/` — a WebDAV listing.
 *
 * Two things here are only possible because the library treats HTTP as data rather than
 * as an enum: the method is an arbitrary string, and `207` is just a number. Neither
 * needed any support beyond being written down.
 */
export const propfind = fileApi.createRequest({
  method: "PROPFIND",
  path: "/dav/",
  headers: { depth: "1" },
  responses: [response({ _tag: "multiStatus", status: 207 }, MultiStatus, { codec: ResponseBody.text })],
});

/**
 * `POST /upload` — the 2019 endpoint that speaks JSON and multipart.
 *
 * `Schema.instanceOf(FormData)` is an identity schema: its `Type` and `Encoded` are both
 * `FormData`, which is what `RequestBody.formData` already handles, so the caller's own
 * `FormData` reaches the transport untouched.
 */
export const uploadMultipart = fileApi.createRequest({
  method: "POST",
  path: "/upload",
  body: Schema.instanceOf(FormData),
  bodyCodec: RequestBody.formData,
  // The multipart codec sets its own content type with the boundary; the API-wide
  // `text/xml` would otherwise make the body unparseable.
  removeHeaders: ["content-type"],
  responses: [
    response({ _tag: "created", status: 201 }, UploadReceipt),
    response({ _tag: "unauthorized", status: 401 }, Schema.Struct({ error: Schema.String })),
  ],
});

/**
 * `GET /bundle` — metadata and bytes in one multipart response.
 *
 * `ResponseBody.formData` hands over a real `FormData`; `FileBundle` reads the parts out
 * of it, which is asynchronous, which an Effect Schema transform handles natively.
 */
export const getBundle = fileApi.createRequest({
  method: "GET",
  path: "/bundle",
  responses: [response({ _tag: "ok", status: 200 }, FileBundle, { codec: ResponseBody.formData })],
});

/**
 * The download the original WCF service really did model as a `GET` carrying a SOAP
 * body, kept as a demonstration.
 *
 * The library refuses it after request transforms and before dispatch, with
 * `RequestBodyNotAllowed`. That is the correct call: a `GET` body is not forbidden by
 * the specification so much as meaningless to intermediaries, and a client that sends
 * one silently produces requests that work in development and vanish behind a proxy.
 */
export const attemptDownloadFileViaGet = (fileId: string) =>
  soapCall()
    .setHeader("soapaction", soapActionHeader("DownloadFile"))
    .setBody(soapEnvelope(soapAction("DownloadFile", { FileId: fileId })))
    .mapRequest((request) => HttpClientRequest.setMethod(request, "GET"));
