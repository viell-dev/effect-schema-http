import { HttpClientRequest } from "@effect/platform";
import { toEffect } from "viell-effect-schema-http";
import { describe, expect, it } from "vitest";
import { run } from "../src/runtime.js";
import {
  createComment,
  createProject,
  createTask,
  downloadFileProxy,
  listProjects,
  listTasks,
  patchProject,
  search,
  uploadFileProxy,
} from "../src/services/apiClient.js";
import {
  downloadFile,
  getWsdl,
  listFiles,
  uploadFile,
} from "../src/services/fileClient.js";
import {
  getUserInfo,
  register,
  requestToken,
} from "../src/services/idClient.js";
import { setSession } from "../src/session.js";

// Check if servers are running before executing e2e suite
const serversAvailable = async (): Promise<boolean> => {
  try {
    const r1 = await fetch("http://localhost:4100/health");
    const r2 = await fetch("http://localhost:4200/health");
    const r3 = await fetch("http://localhost:4300/health");
    return r1.ok && r2.ok && r3.ok;
  } catch {
    return false;
  }
};

describe.runIf(await serversAvailable())("End-to-End Multi-Service Integration", () => {
  const username = `e2e_${Date.now()}`;
  const password = "e2e_password_123";
  let accessToken = "";
  let refreshToken = "";
  let projectId = "";
  let taskId = "";
  let fileId = "";

  it("1. Registers a new account on Rust ID server (201 with body)", async () => {
    const res = await run(
      register()
        .setBody({
          username,
          email: `${username}@test.com`,
          password,
          display_name: "E2E Tester",
        })
        .pipe(toEffect),
    );
    expect(res.status).toBe(201);
    expect(res.body.username).toBe(username);
  });

  it("2. Logs in on Rust ID server (testing token_type normalization)", async () => {
    const res = await run(
      requestToken()
        .setBody({
          grant_type: "password",
          username,
          password,
        })
        .pipe(toEffect),
    );
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    // Quirk: token_type on wire is "bearer", schema normalizes to "Bearer"
    expect(res.body.token_type).toBe("Bearer");

    accessToken = res.body.access_token;
    refreshToken = res.body.refresh_token;
    setSession({
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      username,
    });
  });

  it("3. Refreshes token on Rust ID server (refresh_token grant)", async () => {
    const res = await run(
      requestToken()
        .setBody({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        })
        .pipe(toEffect),
    );
    expect(res.status).toBe(200);
    // Quirk: wire returned "Bearer" with capital B
    expect(res.body.token_type).toBe("Bearer");
    accessToken = res.body.access_token;
    setSession({
      accessToken,
      refreshToken: res.body.refresh_token,
      tokenType: "Bearer",
      username,
    });
  });

  it("4. Fetches userinfo from Rust ID server", async () => {
    const res = await run(getUserInfo().pipe(toEffect));
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(username);
  });

  it("5. Creates project on Java API server (testing Token header & epoch-ms)", async () => {
    const res = await run(
      createProject()
        .setBody({
          name: "E2E Platform Project",
          description: "Integration test project",
        })
        .pipe(toEffect),
    );
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(username);
    expect(res.body.createdAt).toBeInstanceOf(Date);
    projectId = res.body.id;
  });

  it("6. Verifies PATCH returns OLD state quirk on Java API server", async () => {
    const patchRes = await run(
      patchProject({ id: projectId })
        .setBody({
          name: "E2E Platform Project Renamed",
        })
        .pipe(toEffect),
    );
    // Quirk: returns OLD name!
    expect(patchRes.body.name).toBe("E2E Platform Project");

    // Re-fetch to confirm it actually changed on server
    const list = await run(listProjects().pipe(toEffect));
    const updated = list.body.find((p) => p.id === projectId);
    expect(updated?.name).toBe("E2E Platform Project Renamed");
  });

  it("7. Creates task on Java API server (testing string status request vs integer ordinal response)", async () => {
    const res = await run(
      createTask()
        .setBody({
          projectId,
          title: "Implement Quirk Tests",
          status: "OPEN",
        })
        .pipe(toEffect),
    );
    expect(res.status).toBe(201);
    // Quirk: wire ordinal 0 was decoded back to string "OPEN" by schema
    expect(res.body.status).toBe("OPEN");
    taskId = res.body.id;
  });

  it("8. Creates comment on Java API server (200 OK + relative Location header)", async () => {
    const res = await run(
      createComment()
        .setBody({
          taskId,
          body: "Everything is tested.",
        })
        .pipe(toEffect),
    );
    // Quirk: 200 OK, not 201 Created
    expect(res.status).toBe(200);
    expect(res.body.body).toBe("Everything is tested.");
    expect(res.headers.location).toBe(`/api/comments/${res.body.id}`);
  });

  it("9. Searches on Java API server (unwrapped single object vs array normalized)", async () => {
    const res = await run(search("Implement Quirk").pipe(toEffect));
    expect(res.status).toBe(200);
    // Quirk: exactly 1 match returned as bare object on wire, normalized to Array by schema
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]?.id).toBe(taskId);
  });

  it("10. Uploads file to Python SOAP File server (FaultCode 0, HTTP 200)", async () => {
    const textData = "Hello from full end-to-end multi-service test!";
    const b64 = btoa(textData);
    const res = await run(uploadFile("e2e.txt", "text/plain", b64).pipe(toEffect));
    expect(res.status).toBe(200);
    expect(res.body.fileId).toBeDefined();
    fileId = res.body.fileId;
  });

  it("11. Lists files on Python SOAP File server (single file wrapped in <Result><File> & US date)", async () => {
    const res = await run(listFiles().pipe(toEffect));
    expect(res.status).toBe(200);
    const myFile = res.body.find((f) => f.id === fileId);
    expect(myFile).toBeDefined();
    expect(myFile?.name).toBe("e2e.txt");
    expect(myFile?.lastModified).toBeInstanceOf(Date);
  });

  it("12. Downloads file from Python SOAP File server via SOAP POST", async () => {
    const res = await run(downloadFile(fileId).pipe(toEffect));
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(res.body);
    expect(text).toBe("Hello from full end-to-end multi-service test!");
  });

  it("13. Downloads file via Java API server proxy", async () => {
    const res = await run(downloadFileProxy({ id: fileId }).pipe(toEffect));
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(res.body);
    expect(text).toBe("Hello from full end-to-end multi-service test!");
  });

  it("14. Confirms viell-effect-schema-http strictly rejects GET requests carrying a body (RequestBodyNotAllowed)", async () => {
    const { attemptDownloadFileViaGet } = await import("../src/services/fileClient.js");
    let caughtError: any = null;
    try {
      await run(attemptDownloadFileViaGet(fileId).pipe(toEffect));
    } catch (err: any) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
    // Verifies the library invariant: RequestBodyNotAllowed is raised
    expect(String(caughtError)).toContain("RequestBodyNotAllowed");
  });
});
