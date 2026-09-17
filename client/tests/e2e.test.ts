import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
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
import { attemptDownloadFileViaGet, downloadFile, getWsdl, listFiles, uploadFile } from "../src/services/fileClient.js";
import { getUserInfo, register, requestToken } from "../src/services/idClient.js";
import { setSession } from "../src/session.js";
import { call, callFailure, expectTag, servicesUp } from "./support.js";

/**
 * The original end-to-end path across all three of the first-pass services.
 *
 * Every call narrows its response envelope before reading a body. That is not test
 * ceremony: a mapped `401` or `409` is an ordinary member of the same union as the
 * success here, so reading `.body.id` without narrowing is exactly the mistake the
 * library's types exist to prevent.
 */
describe.runIf(await servicesUp([4100, 4200, 4300]))("end to end across three services", () => {
  const username = `e2e_${Date.now()}`;
  const password = "e2e_password_123";
  let refreshToken = "";
  let projectId = "";
  let taskId = "";
  let fileId = "";

  it("registers on the Rust ID server, which answers 201 with the user", async () => {
    const created = await call(
      register().execute({
        body: {
          username,
          email: `${username}@test.invalid`,
          password,
          display_name: "E2E Tester",
        },
      }),
      "created",
    );
    expect(created.value.username).toBe(username);
  });

  it('logs in, where the wire says "bearer" and the schema says Bearer', async () => {
    const ok = await call(requestToken().execute({ body: { grant_type: "password", username, password } }), "ok");
    expect(ok.value.token_type).toBe("Bearer");

    refreshToken = ok.value.refresh_token;
    setSession({ accessToken: ok.value.access_token, refreshToken, tokenType: "Bearer", username });
  });

  it('refreshes, where the other code path says "Bearer" and the schema agrees', async () => {
    const ok = await call(
      requestToken().execute({ body: { grant_type: "refresh_token", refresh_token: refreshToken } }),
      "ok",
    );
    expect(ok.value.token_type).toBe("Bearer");
    setSession({
      accessToken: ok.value.access_token,
      refreshToken: ok.value.refresh_token,
      tokenType: "Bearer",
      username,
    });
  });

  it("reads the profile the login response deliberately omitted", async () => {
    const ok = await call(getUserInfo().execute(undefined), "ok");
    expect(ok.value.username).toBe(username);
  });

  it("creates a project on the Java API server, over the Token auth scheme", async () => {
    const created = await call(
      createProject().execute({ body: { name: "E2E Platform Project", description: "Integration test project" } }),
      "created",
    );
    expect(created.value.owner).toBe(username);
    // An Effect DateTime.Utc, not a bare Date: the transform lives in common.ts because
    // the Ruby service copied this convention and the two now have to agree.
    expect(DateTime.isDateTime(created.value.createdAt)).toBe(true);
    projectId = created.value.id;
  });

  it("PATCHes a project and gets the state it had before the write", async () => {
    const patched = await call(
      patchProject().execute({ path: { id: projectId }, body: { name: "E2E Platform Project Renamed" } }),
      "ok",
    );
    expect(patched.value.name).toBe("E2E Platform Project");

    const listed = await call(listProjects().execute(undefined), "ok");
    expect(listed.value.find((project) => project.id === projectId)?.name).toBe("E2E Platform Project Renamed");
  });

  it("creates a task, sending a status name and receiving an ordinal", async () => {
    const created = await call(
      createTask().execute({ body: { projectId, title: `Implement Quirk Tests ${username}`, status: "OPEN" } }),
      "created",
    );
    expect(created.value.status).toBe("OPEN");
    taskId = created.value.id;

    const tasks = await call(listTasks(projectId), "ok");
    expect(tasks.value.some((task) => task.id === taskId)).toBe(true);
  });

  it("creates a comment, which answers 200 with a relative Location", async () => {
    const ok = await call(createComment().execute({ body: { taskId, body: "Everything is tested." } }), "ok");
    expect(ok.value.body).toBe("Everything is tested.");
    expect(ok.metadata.headers.location).toBe(`/api/comments/${ok.value.id}`);
  });

  it("searches, where one hit is not wrapped in an array", async () => {
    const ok = await call(search(`Implement Quirk Tests ${username}`), "ok");
    expect(ok.value).toHaveLength(1);
    expect(ok.value[0]?.id).toBe(taskId);
  });

  it("uploads to the Python SOAP service, which reports success inside a 200", async () => {
    const ok = await call(uploadFile("e2e.txt", "text/plain", btoa("Hello from the multi-service test!")), "ok");
    // The transport said 200 either way; only the body knows whether it worked.
    const result = expectTag(ok.value, "ok");
    expect(result.value.fileId).toBeTruthy();
    fileId = result.value.fileId;
  });

  it("lists files across the three shapes the .NET serializer used to emit", async () => {
    const ok = await call(listFiles(), "ok");
    const files = expectTag(ok.value, "ok").value;
    const mine = files.find((file) => file.id === fileId);
    expect(mine?.name).toBe("e2e.txt");
    expect(DateTime.isDateTime(mine!.lastModified)).toBe(true);
  });

  it("downloads the bytes directly and through the Java proxy", async () => {
    const direct = await call(downloadFile(fileId), "ok");
    expect(new TextDecoder().decode(direct.value)).toBe("Hello from the multi-service test!");

    const proxied = await call(downloadFileProxy().execute({ path: { id: fileId } }), "ok");
    expect(new TextDecoder().decode(proxied.value)).toBe("Hello from the multi-service test!");
  });

  it("uploads through the Java proxy, which translates JSON into SOAP on the way", async () => {
    const ok = await call(
      uploadFileProxy().execute({
        body: {
          fileName: "proxied.txt",
          contentType: "text/plain",
          fileData: btoa("through the proxy"),
        },
      }),
      "ok",
    );
    expect(ok.value.status).toBe("uploaded");
  });

  it("serves the WSDL for a bare ?wsdl key, which is the only form it accepts", async () => {
    const ok = await call(getWsdl().execute(undefined), "ok");
    expect(ok.value).toContain("urn:filestore:2011");
  });

  it("refuses to put a body on a GET before anything reaches the network", async () => {
    // The original service modelled downloads as a GET carrying a SOAP envelope. The
    // library rejects that after request transforms and before dispatch, so the failure
    // is a typed library error rather than whatever the server would have made of it.
    const failure = await callFailure(attemptDownloadFileViaGet(fileId));
    expect(failure).toMatchObject({ _tag: "InvalidRequest" });
  });
});
