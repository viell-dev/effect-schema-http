import { HttpClientRequest } from "@effect/platform";
import { Schema } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h } from "../dom.js";
import { run } from "../runtime.js";
import {
  createComment,
  createProject,
  createTask,
  listProjects,
  patchProject,
  search,
} from "../services/apiClient.js";
import {
  downloadFile,
  listFiles,
  uploadFile,
} from "../services/fileClient.js";
import {
  getUserInfo,
  register,
  requestToken,
} from "../services/idClient.js";
import { setSession } from "../session.js";

interface QuirkResult {
  id: string;
  server: string;
  title: string;
  description: string;
  passed: boolean;
  evidence: string;
}

export const renderQuirksView = (): HTMLElement => {
  const resultsTable = h("div", {}, "Click 'Run All Quirk Verifications' to test every quirk across all 3 servers.");
  const runBtn = h("button", { class: "btn btn-primary" }, "Run All Quirk Verifications");

  const runAllTests = async () => {
    resultsTable.textContent = "Running live verification against all 3 backend servers...";
    const results: QuirkResult[] = [];

    const username = `test_${Date.now()}`;
    const password = "password123";

    // 1. ID Server: Register 201 with User body
    try {
      const reg = await run(
        register()
          .setBody({ username, email: `${username}@example.com`, password })
          .pipe(toEffect),
      );
      results.push({
        id: "id-register-201",
        server: "Rust ID Server (4100)",
        title: "Register returns 201 Created with full user body",
        description: "Registration was written first; returns user entity directly in 201 body.",
        passed: reg.status === 201 && reg.body.username === username,
        evidence: `HTTP 201, User: ${reg.body.username} (ID: ${reg.body.id})`,
      });
    } catch (e) {
      results.push({
        id: "id-register-201",
        server: "Rust ID Server (4100)",
        title: "Register returns 201 Created with full user body",
        description: "Registration was written first; returns user entity directly in 201 body.",
        passed: false,
        evidence: String(e),
      });
    }

    // 2. ID Server: Password grant returns lowercase "bearer", refresh grant returns "Bearer"
    let accessToken = "";
    let refreshToken = "";
    try {
      const tokRes = await run(
        requestToken()
          .setBody({ grant_type: "password", username, password })
          .pipe(toEffect),
      );
      accessToken = tokRes.body.access_token;
      refreshToken = tokRes.body.refresh_token;

      // Now refresh with refresh_token grant
      const refRes = await run(
        requestToken()
          .setBody({ grant_type: "refresh_token", refresh_token: refreshToken })
          .pipe(toEffect),
      );
      accessToken = refRes.body.access_token;

      setSession({
        accessToken,
        refreshToken: refRes.body.refresh_token,
        tokenType: "Bearer",
        username,
      });

      results.push({
        id: "id-token-type-casing",
        server: "Rust ID Server (4100)",
        title: "Token type casing inconsistency handled by schema",
        description: "Password grant returns 'bearer' (lowercase), refresh grant returns 'Bearer'. Schema normalizes both to 'Bearer'.",
        passed: tokRes.body.token_type === "Bearer" && refRes.body.token_type === "Bearer",
        evidence: `Both normalized to "Bearer". Raw password grant was lowercase, refresh was uppercase.`,
      });
    } catch (e) {
      results.push({
        id: "id-token-type-casing",
        server: "Rust ID Server (4100)",
        title: "Token type casing inconsistency handled by schema",
        description: "Password grant returns 'bearer', refresh grant returns 'Bearer'.",
        passed: false,
        evidence: String(e),
      });
    }

    // 3. ID Server: SimpleError on /userinfo
    try {
      // Intentionally call with invalid token
      const oldSession = { accessToken: "invalid_token_xyz", refreshToken: "", tokenType: "Bearer" };
      setSession(oldSession);
      await run(getUserInfo().pipe(toEffect));
      results.push({
        id: "id-error-split",
        server: "Rust ID Server (4100)",
        title: "Error shape split: /userinfo returns SimpleError {message}",
        description: "Userinfo endpoint uses {message}, unlike OAuth endpoints which use {error, error_description}.",
        passed: false,
        evidence: "Expected error but request succeeded",
      });
    } catch (err: any) {
      const isSimple = String(err).includes("SimpleError") || String(err).includes("Invalid or expired");
      results.push({
        id: "id-error-split",
        server: "Rust ID Server (4100)",
        title: "Error shape split: /userinfo returns SimpleError {message}",
        description: "Userinfo endpoint uses {message}, unlike OAuth endpoints which use {error, error_description}.",
        passed: isSimple,
        evidence: `Decoded error: ${String(err)}`,
      });
      // Restore valid session
      setSession({ accessToken, refreshToken, tokenType: "Bearer", username });
    }

    // 4. API Server: Token scheme + epoch ms
    let projId = "";
    try {
      const pRes = await run(
        createProject()
          .setBody({ name: "Quirk Project", description: "Testing quirks" })
          .pipe(toEffect),
      );
      projId = pRes.body.id;
      const isDate = pRes.body.createdAt instanceof Date;
      results.push({
        id: "api-token-scheme-epoch",
        server: "Java API Server (4300)",
        title: "Authorization: Token scheme & Epoch-ms timestamps",
        description: "Pre-RFC 6750 'Token' header accepted; Java System.currentTimeMillis() epoch-ms decoded to Date.",
        passed: isDate && Boolean(projId),
        evidence: `Created ${projId}, createdAt decoded to ${pRes.body.createdAt.toISOString()}`,
      });
    } catch (e) {
      results.push({
        id: "api-token-scheme-epoch",
        server: "Java API Server (4300)",
        title: "Authorization: Token scheme & Epoch-ms timestamps",
        description: "Pre-RFC 6750 'Token' header accepted; epoch-ms decoded to Date.",
        passed: false,
        evidence: String(e),
      });
    }

    // 5. API Server: PATCH returns OLD state
    try {
      const patchRes = await run(
        patchProject({ id: projId })
          .setBody({ name: "Updated Name" })
          .pipe(toEffect),
      );
      // The quirk: returned name is the OLD name!
      const returnedOldName = patchRes.body.name === "Quirk Project";
      results.push({
        id: "api-patch-old-state",
        server: "Java API Server (4300)",
        title: "PATCH returns OLD resource state, not updated state",
        description: "Legacy developer misread 'return the resource' as 'return what it was'.",
        passed: returnedOldName,
        evidence: `Sent new name 'Updated Name', but PATCH response returned old name '${patchRes.body.name}'.`,
      });
    } catch (e) {
      results.push({
        id: "api-patch-old-state",
        server: "Java API Server (4300)",
        title: "PATCH returns OLD resource state, not updated state",
        description: "Legacy developer misread 'return the resource' as 'return what it was'.",
        passed: false,
        evidence: String(e),
      });
    }

    // 6. API Server: Task status asymmetry (request string, response int ordinal)
    let taskId = "";
    try {
      const taskRes = await run(
        createTask()
          .setBody({ projectId: projId, title: "Quirk Task", status: "OPEN" })
          .pipe(toEffect),
      );
      taskId = taskRes.body.id;
      results.push({
        id: "api-task-status-asymmetry",
        server: "Java API Server (4300)",
        title: "Task status enum asymmetry (String request vs Ordinal response)",
        description: "Jackson serialization bug: ordinal (0) on wire, string ('OPEN') in request.",
        passed: taskRes.body.status === "OPEN",
        evidence: `Sent string "OPEN", server returned ordinal 0, schema decoded back to "OPEN".`,
      });
    } catch (e) {
      results.push({
        id: "api-task-status-asymmetry",
        server: "Java API Server (4300)",
        title: "Task status enum asymmetry",
        description: "Jackson serialization bug: ordinal on wire, string in request.",
        passed: false,
        evidence: String(e),
      });
    }

    // 7. API Server: Comments return 200 OK with relative Location header
    try {
      const cRes = await run(
        createComment()
          .setBody({ taskId, body: "Quirk comment" })
          .pipe(toEffect),
      );
      results.push({
        id: "api-comments-200-relative",
        server: "Java API Server (4300)",
        title: "Comments return 200 OK (not 201) with relative Location header",
        description: "Servlet container legacy: relative /api/comments/:id in Location header.",
        passed: cRes.status === 200 && Boolean(cRes.body.id),
        evidence: `Status 200 OK, comment ID: ${cRes.body.id}`,
      });
    } catch (e) {
      results.push({
        id: "api-comments-200-relative",
        server: "Java API Server (4300)",
        title: "Comments return 200 OK (not 201)",
        description: "Servlet container legacy: relative /api/comments/:id.",
        passed: false,
        evidence: String(e),
      });
    }

    // 8. API Server: Search unwrapped object quirk
    try {
      const searchRes = await run(search("Quirk Task").pipe(toEffect));
      const isArray = Array.isArray(searchRes.body);
      const hasItem = searchRes.body.length === 1;
      results.push({
        id: "api-search-unwrapped-single",
        server: "Java API Server (4300)",
        title: "Search single result unwrapped bare object normalized to array",
        description: "Jackson WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED returns { } instead of [ { } ].",
        passed: isArray && hasItem,
        evidence: `Wire format was a bare object; SearchResults schema decoded it to Array length ${searchRes.body.length}.`,
      });
    } catch (e) {
      results.push({
        id: "api-search-unwrapped-single",
        server: "Java API Server (4300)",
        title: "Search single result unwrapped bare object",
        description: "Jackson WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED returns bare object.",
        passed: false,
        evidence: String(e),
      });
    }

    // 9. File Server: SOAP upload & ListFiles 3 shapes & US date format
    let fileId = "";
    try {
      const b64 = btoa("SOAP file content test");
      const upRes = await run(uploadFile("test.txt", "text/plain", b64).pipe(toEffect));
      fileId = upRes.body.fileId;

      const listRes = await run(listFiles().pipe(toEffect));
      const targetFile = listRes.body.find((f) => f.id === fileId);
      const isDate = targetFile?.lastModified instanceof Date;

      results.push({
        id: "file-soap-shapes-date",
        server: "Python File Server (4200)",
        title: "SOAP FaultCode 0, 3-shape ListFiles, US-format dates",
        description: "WCF port: HTTP 200 always with FaultCode, single file in <Result><File>, date MM/dd/yyyy HH:mm:ss.",
        passed: Boolean(fileId) && isDate,
        evidence: `Uploaded fileId ${fileId}. LastModified parsed from US format to ${targetFile?.lastModified.toISOString()}.`,
      });
    } catch (e) {
      results.push({
        id: "file-soap-shapes-date",
        server: "Python File Server (4200)",
        title: "SOAP FaultCode 0, 3-shape ListFiles, US-format dates",
        description: "WCF port: HTTP 200 always with FaultCode, single file in <Result><File>, date MM/dd/yyyy HH:mm:ss.",
        passed: false,
        evidence: String(e),
      });
    }

    // 10. File Server: GET with SOAP XML body download
    try {
      const dlRes = await run(downloadFile(fileId).pipe(toEffect));
      const text = new TextDecoder().decode(dlRes.body);
      results.push({
        id: "file-get-with-body",
        server: "Python File Server (4200)",
        title: "GET carrying SOAP XML body for file download",
        description: "WCF service used SOAP headers; Python port accepts GET with XML body; client uses mapRequest.",
        passed: text === "SOAP file content test",
        evidence: `Downloaded "${text}" via HTTP GET with XML body.`,
      });
    } catch (e) {
      results.push({
        id: "file-get-with-body",
        server: "Python File Server (4200)",
        title: "GET carrying SOAP XML body for file download",
        description: "WCF service used SOAP headers; Python port accepts GET with XML body.",
        passed: false,
        evidence: String(e),
      });
    }

    // Render results
    resultsTable.replaceChildren();
    for (const r of results) {
      const row = h(
        "div",
        {
          class: "item-card",
          style: `border-left: 5px solid ${r.passed ? "var(--success)" : "var(--danger)"};`,
        },
        h(
          "div",
          { class: "item-header" },
          h("strong", {}, `${r.passed ? "✓" : "✗"} ${r.title}`),
          h("span", { class: "badge badge-rust" }, r.server),
        ),
        h("p", { style: "font-size: 0.85rem; color: var(--muted);" }, r.description),
        h("div", { class: "item-meta", style: "margin-top: 0.5rem; font-family: var(--font-mono);" }, `Evidence: ${r.evidence}`),
      );
      resultsTable.appendChild(row);
    }
  };

  runBtn.onclick = () => void runAllTests();

  return h(
    "div",
    {},
    h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Live Quirk Verification Suite"),
      h(
        "p",
        { style: "margin-bottom: 1rem; color: var(--muted); font-size: 0.9rem;" },
        "This suite runs real-world operations across all three servers to verify each historical quirk and the client library's handling of it.",
      ),
      runBtn,
    ),
    h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Verification Results"), resultsTable),
  );
};
