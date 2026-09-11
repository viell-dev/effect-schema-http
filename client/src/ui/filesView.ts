import { DateTime } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h } from "../dom.js";
import { run } from "../runtime.js";
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
} from "../services/fileClient.js";
import { actionPanel, field, show, type Action } from "./panel.js";

/** Every call in this view goes to the Python SOAP service on :4200. */
export const renderFilesView = (): HTMLElement => {
  const fileName = field("file name", "Rapport Anné.txt");
  const contents = field("contents", "bonjour, ceci est un fichier");
  const fileId = field("file id", "");

  const toBase64 = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    return btoa([...bytes].map((byte) => String.fromCharCode(byte)).join(""));
  };

  const actions: ReadonlyArray<Action> = [
    {
      label: "Upload over SOAP",
      note: "A quoted SOAPAction header, base64 inside an XML element, and a fault code inside a 200.",
      run: async () => {
        const result = await run(
          uploadFile(fileName.input.value, "text/plain", toBase64(contents.input.value)).pipe(toEffect),
        );
        if (result._tag !== "ok") return `${result._tag}: ${show(result.body)}`;
        if (result.body._tag === "SoapFault") return `fault ${result.body.faultCode}: ${result.body.faultString}`;
        fileId.input.value = result.body.value.fileId;
        return `stored ${result.body.value.fileId}\nThe transport said 200 either way; only <FaultCode> knew.`;
      },
    },
    {
      label: "List files",
      note: "Empty, one-wrapped-in-Result, and many are three different documents. One schema reads all three.",
      run: async () => {
        const result = await run(listFiles().pipe(toEffect));
        if (result._tag !== "ok") return show(result.body);
        if (result.body._tag === "SoapFault") return `fault ${result.body.faultCode}: ${result.body.faultString}`;
        return (
          result.body.value
            .map((item) => `${item.id}  ${DateTime.formatIso(item.lastModified)}  ${item.name}`)
            .join("\n") || "no files"
        );
      },
    },
    {
      label: "Send an unquoted SOAPAction",
      note: "SOAP 1.1 requires the quotes and the ESB routes on the literal string.",
      run: async () => {
        const result = await run(listFiles().setHeader("soapaction", "urn:filestore:2011/ListFiles").pipe(toEffect));
        if (result._tag !== "ok") return show(result.body);
        return result.body._tag === "SoapFault"
          ? `fault ${result.body.faultCode}: ${result.body.faultString}`
          : "unexpectedly accepted";
      },
    },
    {
      label: "Read the metadata (SOAP 1.1)",
      note: "The ordinary envelope, with a .NET US timestamp and no timezone anywhere.",
      run: async () => {
        const result = await run(getFileMetadata(fileId.input.value).pipe(toEffect));
        if (result._tag !== "ok") return show(result.body);
        return result.body._tag === "SoapFault"
          ? `fault ${result.body.faultCode}: ${result.body.faultString}`
          : show({ ...result.body.value, lastModified: DateTime.formatIso(result.body.value.lastModified) });
      },
    },
    {
      label: "Read the archive document (SOAP 1.2)",
      note: "ISO-8859-1 bytes under a bare text/xml. Read as text, the accents do not survive.",
      run: async () => {
        const result = await run(getArchiveMetadata(fileId.input.value).pipe(toEffect));
        if (result._tag !== "ok") return show(result.body);
        return [
          `archivist:   ${result.body.archivist}`,
          `department:  ${result.body.department}`,
          "",
          "The declaration says ISO-8859-1 and the Content-Type says nothing, so the schema",
          "takes bytes and reads the encoding out of the document itself.",
        ].join("\n");
      },
    },
    {
      label: "Purge (a real fault, with a real status)",
      note: "The one action written by someone who had read the specification.",
      run: async () => {
        const result = await run(purgeFiles().pipe(toEffect));
        return result._tag === "SoapFaultStatus"
          ? `HTTP ${result.status}\n${result.body.faultcode}: ${result.body.faultstring}\n${result.body.reason}`
          : `unexpected ${result._tag}`;
      },
    },
    {
      label: "Fetch the contract (?wsdl, then ?wsdl=)",
      note: "A bare query key and an empty value are different requests, and this service agrees.",
      run: async () => {
        const bare = await run(getWsdl().pipe(toEffect));
        const valued = await run(getWsdlWithValue().pipe(toEffect));
        const refused =
          valued._tag === "ok" && valued.body._tag === "SoapFault" ? valued.body.faultString : "unexpectedly accepted";
        return [
          `?wsdl  -> ${bare._tag === "ok" ? `${bare.body.length} bytes of WSDL` : "failed"}`,
          `?wsdl= -> ${refused}`,
        ].join("\n");
      },
    },
    {
      label: "PROPFIND the collection",
      note: "An arbitrary HTTP method and a 207, neither of which needed library support.",
      run: async () => {
        const result = await run(propfind().pipe(toEffect));
        if (result._tag !== "multiStatus") return show(result);
        return [
          `HTTP ${result.status}, DAV: ${result.headers.dav}`,
          "",
          ...result.body.map((resource) => `${resource.href}  ${resource.contentLength}B  ${resource.displayName}`),
        ].join("\n");
      },
    },
    {
      label: "Upload multipart (the 2019 endpoint)",
      note: "A real FormData through RequestBody.formData, answered with JSON, 201 and a Location.",
      run: async () => {
        const form = new FormData();
        form.append("label", fileName.input.value);
        form.append("file", new Blob([new TextEncoder().encode(contents.input.value)]), "upload.txt");
        const result = await run(uploadMultipart().setBody(form).pipe(toEffect));
        if (result._tag !== "created") return show(result.body);
        fileId.input.value = result.body.fileId;
        return `${show(result.body)}\nLocation: ${result.headers.location}`;
      },
    },
    {
      label: "Download the bundle",
      note: "Metadata and bytes in one multipart response; reading a part is async, and the schema awaits it.",
      run: async () => {
        const result = await run(getBundle().setUrlParam("id", fileId.input.value).pipe(toEffect));
        if (result._tag !== "ok") return show(result);
        return [
          show({ ...result.body.metadata, lastModified: DateTime.formatIso(result.body.metadata.lastModified) }),
          "",
          `content: ${new TextDecoder().decode(result.body.content)}`,
        ].join("\n");
      },
    },
  ];

  return h(
    "div",
    {},
    h("div", { class: "fields" }, fileName.row, contents.row, fileId.row),
    actionPanel(
      "Python SOAP service, :4200",
      "A 2011 namespace, outcomes inside 200s, a serializer bug preserved on purpose, ISO-8859-1 archive documents, WebDAV, and one endpoint an intern wrote in 2019.",
      actions,
    ),
  );
};
