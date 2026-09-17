import { DateTime, Schema } from "effect";
import { Request } from "viell-effect-schema-http";
import { beforeAll, describe, expect, it } from "vitest";
import { soapActionHeader } from "../src/schemas/fileServer.js";
import {
  getArchiveMetadata,
  getBundle,
  getFileMetadata,
  getWsdl,
  getWsdlWithValue,
  listFiles,
  propfind,
  purgeFiles,
  uploadFile,
  uploadMultipart,
} from "../src/services/fileClient.js";
import { register, requestToken } from "../src/services/idClient.js";
import { setSession } from "../src/session.js";
import { call, expectTag, servicesUp } from "./support.js";

const up = await servicesUp([4100, 4200]);

describe.runIf(up)("File server — SOAP, WebDAV, and whatever the intern added", () => {
  const username = `soap_${Date.now()}`;
  const password = "soap_password_123";
  let fileId = "";

  beforeAll(async () => {
    await call(register().execute({ body: { username, email: `${username}@test.invalid`, password } }), "created");
    const token = await call(requestToken().execute({ body: { grant_type: "password", username, password } }), "ok");
    setSession({
      accessToken: token.value.access_token,
      refreshToken: token.value.refresh_token,
      tokenType: "Bearer",
      username,
    });
  });

  describe("SOAPAction, which the ESB routes on", () => {
    it("is refused when it is missing", async () => {
      const ok = await call(
        listFiles({ request: (request) => request.pipe(Request.removeHeader("soapaction")) }),
        "ok",
      );
      const fault = expectTag(ok.value, "SoapFault");
      expect(fault.faultString).toContain("SOAPAction header is required");
    });

    it("is refused when it is unquoted", async () => {
      const ok = await call(
        listFiles({
          request: (request) => request.pipe(Request.setHeader("soapaction", "urn:filestore:2011/ListFiles")),
        }),
        "ok",
      );
      const fault = expectTag(ok.value, "SoapFault");
      expect(fault.faultString).toContain("must be quoted");
    });

    it("is accepted when it is quoted, which is what the endpoint declares", async () => {
      const ok = await call(listFiles(), "ok");
      expect(ok.value._tag).toBe("ok");
    });
  });

  it("uploads through SOAP and reads the file back through metadata", async () => {
    const uploaded = await call(uploadFile("Rapport.txt", "text/plain", btoa("bonjour")), "ok");
    fileId = expectTag(uploaded.value, "ok").value.fileId;

    const metadata = await call(getFileMetadata(fileId), "ok");
    const item = expectTag(metadata.value, "ok").value;
    expect(item.name).toBe("Rapport.txt");
    expect(DateTime.isDateTime(item.lastModified)).toBe(true);
  });

  it("reads the archive's Latin-1 document as bytes, because text would mangle it", async () => {
    const ok = await call(getArchiveMetadata(fileId), "ok");

    // These characters only survive because the schema read the encoding out of the
    // document's own declaration instead of trusting a content type that has none.
    expect(ok.value.archivist).toBe("Renée Müller");
    expect(ok.value.department).toBe("Bücherei");
    expect(ok.value.fileId).toBe(fileId);
  });

  it("treats the one action with a real status and a real fault as an ordinary response", async () => {
    const fault = await call(purgeFiles(), "SoapFaultStatus");
    expect(fault.metadata.status).toBe(500);
    expect(fault.value.faultcode).toBe("soap:Server");
    expect(fault.value.reason).toContain("change request");
  });

  describe("the contract, requested the way toolkits request it", () => {
    it("answers a bare ?wsdl key", async () => {
      const ok = await call(getWsdl().execute(undefined), "ok");
      expect(ok.value).toContain("FileStoreService");
      // The library distinguishes a bare key from an empty value, which is the whole
      // difference between these two endpoints.
      expect(ok.value).toContain("urn:filestore:2011");
    });

    it("refuses ?wsdl= , which is a different request", async () => {
      const refused = await call(getWsdlWithValue().execute(undefined), "ok");
      const fault = expectTag(refused.value, "SoapFault");
      expect(fault.faultString).toContain("?wsdl with no value");
    });
  });

  it("speaks PROPFIND and 207, neither of which needed library support", async () => {
    const multi = await call(propfind().execute(undefined), "multiStatus");
    expect(multi.metadata.status).toBe(207);
    expect(multi.metadata.headers.dav).toBe("1, 2");
    expect(multi.value.some((resource) => resource.href.endsWith(fileId))).toBe(true);
  });

  describe("the 2019 endpoints, which speak JSON and multipart", () => {
    let multipartId = "";

    it("uploads a real FormData with no schema written for the codec", async () => {
      const form = new FormData();
      form.append("label", "Rapport Anné.txt");
      form.append("file", new Blob([new TextEncoder().encode("héllo bytes")]), "upload.txt");

      const created = await call(uploadMultipart().execute({ body: form }), "created");
      expect(created.value.fileName).toBe("Rapport Anné.txt");
      expect(created.value.sizeBytes).toBeGreaterThan(0);
      expect(DateTime.isDateTime(created.value.uploadedAt)).toBe(true);
      // The only endpoint here that sets a Location, and the only one that is correct.
      expect(created.metadata.headers.location).toBe(`/bundle?id=${created.value.fileId}`);
      multipartId = created.value.fileId;
    });

    it("reads metadata and bytes out of one multipart response", async () => {
      const bundle = await call(
        getBundle({ request: (request) => request.pipe(Request.setQuery("id", multipartId)) }).execute(undefined),
        "ok",
      );

      expect(bundle.value.metadata.fileName).toBe("Rapport Anné.txt");
      // Reading a part's bytes is asynchronous, and the schema did the awaiting.
      expect(new TextDecoder().decode(bundle.value.content)).toBe("héllo bytes");
      expect(DateTime.isDateTime(bundle.value.metadata.lastModified)).toBe(true);
    });

    it("answers JSON, not a fault code, when the credential is missing", async () => {
      const rejected = await call(
        uploadMultipart({ request: (request) => request.pipe(Request.removeHeader("authorization")) }).execute({
          body: new FormData(),
        }),
        "unauthorized",
      );
      expect(rejected.value.error).toContain("authorization");
    });
  });

  it("builds the quoted action header the ESB expects", () => {
    expect(soapActionHeader("ListFiles")).toBe('"urn:filestore:2011/ListFiles"');
    expect(Schema.decodeUnknownSync(Schema.String)(soapActionHeader("UploadFile"))).toContain('"');
  });
});
