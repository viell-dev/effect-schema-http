import { toEffect } from "viell-effect-schema-http";
import { append, h } from "../dom.js";
import { run } from "../runtime.js";
import {
  downloadFile,
  getWsdl,
  listFiles,
  uploadFile,
} from "../services/fileClient.js";
import {
  downloadFileProxy,
  uploadFileProxy,
} from "../services/apiClient.js";

export const renderFilesView = (): HTMLElement => {
  const logBox = h("div", { class: "log-box" }, "Ready for file actions...");

  const appendLog = (msg: string) => {
    logBox.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n\n${logBox.textContent}`;
  };

  const filesListContainer = h("div", {}, "Click 'List Files (Direct SOAP)' to load...");

  const loadFiles = async () => {
    try {
      filesListContainer.textContent = "Loading files via SOAP / ListFiles...";
      appendLog("Calling Python File Server via SOAP action <fs:ListFiles/>...");

      const res = await run(listFiles().pipe(toEffect));
      const files = res.body;

      appendLog(`✓ SOAP ListFiles succeeded! Received ${files.length} files.`);
      appendLog(`⚠️ QUIRKS OBSERVED:\n- Zero files returned self-closing <fs:Files/>\n- Single file returned with extra <fs:Result><fs:File> wrapper\n- Dates formatted in US locale MM/dd/yyyy HH:mm:ss transformed to JS Date.`);

      filesListContainer.replaceChildren();
      if (files.length === 0) {
        filesListContainer.textContent = "No files found on server. Upload one!";
        return;
      }

      for (const f of files) {
        const card = h(
          "div",
          { class: "item-card" },
          h(
            "div",
            { class: "item-header" },
            h("strong", {}, f.name),
            h(
              "div",
              { style: "display: flex; gap: 0.5rem;" },
              h(
                "button",
                {
                  class: "btn btn-outline",
                  onclick: async () => {
                    try {
                      appendLog(`Downloading file ${f.id} directly via GET with SOAP body...`);
                      const dlRes = await run(downloadFile(f.id).pipe(toEffect));
                      const textData = new TextDecoder().decode(dlRes.body);
                      appendLog(`✓ Downloaded ${f.name} (${dlRes.body.length} bytes):\n"${textData}"`);
                    } catch (err) {
                      appendLog(`✗ Download failed: ${String(err)}`);
                    }
                  },
                },
                "Direct SOAP Download (GET w/ Body)",
              ),
              h(
                "button",
                {
                  class: "btn btn-outline",
                  onclick: async () => {
                    try {
                      appendLog(`Downloading file ${f.id} via API Server proxy...`);
                      const dlRes = await run(downloadFileProxy({ id: f.id }).pipe(toEffect));
                      const textData = new TextDecoder().decode(dlRes.body);
                      appendLog(`✓ Downloaded via Proxy (${dlRes.body.length} bytes):\n"${textData}"`);
                    } catch (err) {
                      appendLog(`✗ Proxy download failed: ${String(err)}`);
                    }
                  },
                },
                "Download via API Proxy",
              ),
            ),
          ),
          h(
            "div",
            { class: "item-meta" },
            `ID: ${f.id} | Size: ${f.size} bytes | Type: ${f.contentType} | LastModified: ${f.lastModified.toLocaleString()} (Quirk: decoded from US date format)`,
          ),
        );
        filesListContainer.appendChild(card);
      }
    } catch (err) {
      filesListContainer.textContent = `Failed to list files: ${String(err)}`;
      appendLog(`✗ ListFiles failed: ${String(err)}`);
    }
  };

  // Direct SOAP upload
  const uploadName = h("input", { type: "text", placeholder: "File Name", value: "document.txt" });
  const uploadContent = h("textarea", { placeholder: "File text content...", rows: "3" });
  uploadContent.value = "This is a document uploaded directly via SOAP envelope to port 4200.";

  const uploadSoapBtn = h("button", { class: "btn btn-primary" }, "Upload (Direct SOAP)");
  uploadSoapBtn.onclick = async () => {
    try {
      const name = uploadName.value.trim();
      const content = uploadContent.value;
      if (!name || !content) return;

      const base64Data = btoa(unescape(encodeURIComponent(content)));
      appendLog(`Sending SOAP UploadFile action to Python File Server for "${name}"...`);

      const res = await run(uploadFile(name, "text/plain", base64Data).pipe(toEffect));
      appendLog(`✓ SOAP Upload succeeded! FileId: ${res.body.fileId}, Size: ${res.body.fileSize} bytes.`);
      appendLog(`⚠️ QUIRK OBSERVED: HTTP response status was 200 OK with FaultCode=0 in body.`);
      await loadFiles();
    } catch (err) {
      appendLog(`✗ SOAP upload failed: ${String(err)}`);
    }
  };

  // Proxy upload via API Server
  const uploadProxyBtn = h("button", { class: "btn btn-outline" }, "Upload (Via API Server Proxy)");
  uploadProxyBtn.onclick = async () => {
    try {
      const name = uploadName.value.trim();
      const content = uploadContent.value;
      if (!name || !content) return;

      const base64Data = btoa(unescape(encodeURIComponent(content)));
      appendLog(`Sending JSON file upload to Java API Server (POST /api/files)...`);

      const res = await run(
        uploadFileProxy()
          .setBody({
            fileName: name,
            contentType: "text/plain",
            fileData: base64Data,
          })
          .pipe(toEffect),
      );
      appendLog(`✓ Proxy upload succeeded! Response: ${JSON.stringify(res.body, null, 2)}`);
      await loadFiles();
    } catch (err) {
      appendLog(`✗ Proxy upload failed: ${String(err)}`);
    }
  };

  // Inspect WSDL
  const wsdlBtn = h("button", { class: "btn btn-outline" }, "Fetch WSDL (Inspect Quirk)");
  wsdlBtn.onclick = async () => {
    try {
      appendLog("Fetching WSDL from http://localhost:4200/wsdl...");
      const res = await run(getWsdl().pipe(toEffect));
      appendLog(`✓ WSDL retrieved:\n${res.body}`);
      appendLog(`⚠️ QUIRK OBSERVED: WSDL specifies MaxFileSize in bytes, but error messages state 'KB' due to a historical unit mismatch!`);
    } catch (err) {
      appendLog(`✗ WSDL fetch failed: ${String(err)}`);
    }
  };

  const refreshBtn = h("button", { class: "btn btn-outline" }, "List Files (Direct SOAP)");
  refreshBtn.onclick = () => void loadFiles();

  return h(
    "div",
    {},
    h(
      "div",
      { class: "quirk-callout" },
      h("strong", {}, "Historical Quirks on SOAP File Server (Port 4200):"),
      h("br"),
      "1. WCF .NET legacy: Custom XML namespace 'urn:filestore:2011'.",
      h("br"),
      "2. HTTP 200 for EVERYTHING: success/failure is conveyed in the SOAP FaultCode (0 = success).",
      h("br"),
      "3. GET with SOAP body: File download is an HTTP GET request that transmits a SOAP XML envelope in its body!",
      h("br"),
      "4. Date format: .NET US locale 'MM/dd/yyyy HH:mm:ss' without timezone.",
      h("br"),
      "5. ListFiles shape divergence: 0 files (<Files/>), 1 file (wrapped in <Result><File>), multiple files (<File>...<File>).",
      h("br"),
      "6. Unit mismatch: WSDL states byte limit, error message states KB.",
    ),
    h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "File Upload & Actions"),
      h("div", { class: "form-group" }, h("label", {}, "File Name"), uploadName),
      h("div", { class: "form-group" }, h("label", {}, "File Content"), uploadContent),
      h(
        "div",
        { style: "display: flex; gap: 0.5rem; flex-wrap: wrap;" },
        uploadSoapBtn,
        uploadProxyBtn,
        refreshBtn,
        wsdlBtn,
      ),
    ),
    h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Stored Files"), filesListContainer),
    h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Activity Log"), logBox),
  );
};
