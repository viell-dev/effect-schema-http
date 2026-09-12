import { DateTime, Effect, Either, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { applyTerm, makeReconciliationGate } from "../src/integration/gates.js";
import { runReconciliation } from "../src/integration/saga.js";
import {
  DirectoryEntryToAssignee,
  draftToCreateTaskInput,
  ExtractRecordToTaskDraft,
  fileItemToUpload,
  TaskToNotification,
  uploadLosesTimestamp,
} from "../src/integration/translate.js";
import { CreateTaskInput } from "../src/schemas/apiServer.js";
import { Cents } from "../src/schemas/apiLegacy.js";
import { createProject } from "../src/services/apiClient.js";
import { register, requestToken } from "../src/services/idClient.js";
import { run } from "../src/runtime.js";
import { reportLogin } from "../src/services/reportClient.js";
import { setReportSession, setSession } from "../src/session.js";
import { call, expectTag, servicesUp } from "./support.js";

const allUp = await servicesUp([4100, 4200, 4300, 4400, 4500]);

describe("moving a value from one service to another", () => {
  describe("the translation layer, on its own", () => {
    const record = {
      id: "T0000009",
      description: "Rückstellungen review",
      status: "IN_PROGRESS" as const,
      date: DateTime.unsafeMake("2026-09-09T00:00:00Z"),
      amount: Cents.make(98750),
      active: true,
    };

    it("turns a 1999 extract record into a 2014 task, and back again", () => {
      const draft = Schema.decodeSync(ExtractRecordToTaskDraft)(record);

      expect(draft.title).toBe("Rückstellungen review");
      // The enum is the one thing the two systems genuinely share, because the extract
      // is a dump of the API server's own table.
      expect(draft.status).toBe("IN_PROGRESS");
      // The extract's id is from a different id space, so it travels as a visible
      // reference rather than as an identifier.
      expect(draft.description).toContain("ref T0000009");
      expect(draft.description).toContain("987.50");
      // Bands are in cents: 98_750 is $987.50, which is band two.
      expect(draft.priority).toBe(2);

      // The round trip is what proves the mapping is not quietly lossy. A plain mapping
      // function could not be tested this way at all.
      const back = Schema.encodeSync(ExtractRecordToTaskDraft)(draft);
      expect(back.id).toBe(record.id);
      expect(back.description).toBe(record.description);
      expect(back.status).toBe(record.status);
      expect(back.amount).toBe(record.amount);
    });

    it("produces exactly the body the other service's own schema accepts", () => {
      const draft = Schema.decodeSync(ExtractRecordToTaskDraft)(record);
      const input = draftToCreateTaskInput(draft, "p-1");

      // Encoding through the *target service's* schema is the check that matters: if
      // either side renames a field, this stops compiling, not failing in production.
      const wire = Schema.encodeSync(CreateTaskInput)(input);
      expect(wire).toMatchObject({ projectId: "p-1", title: "Rückstellungen review", status: "IN_PROGRESS" });
    });

    it("says out loud what a file loses on its way to the other service", () => {
      const item = {
        id: "f-1",
        name: "Rapport.txt",
        contentType: "text/plain",
        size: 11,
        lastModified: DateTime.unsafeMake("2026-09-09T10:00:00Z"),
      };
      const upload = fileItemToUpload(item, new TextEncoder().encode("héllo bytes"));

      // The API server's proxy has no field for a timestamp or a size, so the timestamp
      // is preserved in the name — the archive's own convention — and the size is simply
      // gone, recoverable from the bytes.
      expect(upload.fileName).toBe("20260909-Rapport.txt");
      expect(uploadLosesTimestamp(item, upload)).toBe(true);
      expect(atob(upload.fileData)).toContain("bytes");
    });

    it("refuses to pretend a notification can become a task again", () => {
      const notification = Schema.decodeSync(TaskToNotification)({
        id: "t-1",
        projectId: "p-1",
        title: "Ship the reconciliation",
        description: "",
        status: "REVIEW",
        assignee: "ada",
        priority: 2,
        createdAt: DateTime.unsafeMake(Date.now()),
        updatedAt: DateTime.unsafeMake(Date.now()),
      });

      expect(notification.text).toBe('"Ship the reconciliation" is assigned to ada and now review');
      // An honest one-way transform: the encode fails with the reason rather than
      // fabricating a task with plausible-looking fields.
      const back = Schema.encodeEither(TaskToNotification)(notification);
      expect(Either.isLeft(back)).toBe(true);
    });

    it("stops an inactive directory entry from being assigned work", () => {
      const active = Schema.decodeSync(DirectoryEntryToAssignee)({
        id: "u-1",
        username: "ada",
        email: null,
        displayName: null,
        createdAt: null,
        active: true,
      });
      expect(active).toBe("ada");

      const inactive = Schema.decodeEither(DirectoryEntryToAssignee)({
        id: null,
        username: "departed",
        email: null,
        displayName: null,
        createdAt: null,
        active: false,
      });
      expect(Either.isLeft(inactive)).toBe(true);
    });
  });

  describe.runIf(allUp)("the whole month-end reconciliation, across five languages", () => {
    const username = `saga_${Date.now()}`;
    const password = "saga_password_123";
    let projectId = "";

    beforeAll(async () => {
      const owner = `${username}_owner`;
      await call(register().setBody({ username: owner, email: `${owner}@test.invalid`, password }), "created");
      const token = await call(requestToken().setBody({ grant_type: "password", username: owner, password }), "ok");
      setSession({
        accessToken: token.body.access_token,
        refreshToken: token.body.refresh_token,
        tokenType: "Bearer",
        username: owner,
      });
      const project = await call(
        createProject().setBody({ name: `Reconciliation ${username}`, description: "" }),
        "created",
      );
      projectId = project.body.id;
    });

    it("reads from Perl, writes to Java, stores in Python, and announces through Ruby", async () => {
      const report = await run(runReconciliation(username, password, projectId));

      // Perl: four detail records and a control total that reconciled.
      expect(report.extractedRecords).toBe(4);
      expect(report.controlTotal).toBe(1234500 + 98750 + 4500000 + 0);

      // Java: one task per record, created from the translated drafts.
      expect(report.createdTaskIds).toHaveLength(4);

      // Python: the re-encoded extract, stored over SOAP. That it round-tripped at all
      // is the schema's doing — the bytes written here were produced by encoding what
      // was decoded from the gateway.
      expect(report.soapFileId).toMatch(/^[0-9a-f-]{36}$/u);

      // Java again, this time proxying JSON into SOAP.
      expect(report.proxyStatus).toBe("uploaded");

      // Ruby: signed, CSRF-guarded, and phrased for a human.
      expect(report.notificationText).toContain("assigned to");

      // And the write is visible through the service's own search.
      expect(report.foundInSearch).toBeGreaterThanOrEqual(1);
    }, 30_000);
  });

  describe.runIf(allUp)("a request gate spanning two services", () => {
    beforeAll(async () => {
      // The gate reads from the Perl gateway, which has its own session and has never
      // heard of the OAuth one. Each suite signs in to every service it touches.
      const gateway = await call(reportLogin().setUrlParam("user", "gate-reader").setUrlParam("pass", "hunter2"), "ok");
      setReportSession(expectTag(gateway.body, "session").session);
    });

    it("reuses a retained success and refreshes past it on demand", async () => {
      const program = Effect.gen(function* () {
        const gate = yield* makeReconciliationGate();

        const first = yield* gate.run("Rückstellungen");
        const second = yield* gate.run("Rückstellungen");
        // The same input resolves from the retained success rather than calling two
        // services again.
        expect(second).toBe(first);

        const refreshed = yield* gate.run("Rückstellungen", { force: true });
        // `force: true` always executes, so this is a different value even though it is
        // equal — which is the observable difference between reuse and re-execution.
        expect(refreshed).not.toBe(first);
        expect(refreshed.drafts).toHaveLength(1);
        expect(refreshed.drafts[0]?.status).toBe("IN_PROGRESS");

        const retained = yield* gate.run("Rückstellungen");
        expect(retained).toBe(refreshed);
        yield* gate.dispose;
        return retained;
      });

      const result = await run(program);
      expect(result.liveMatches).toBeGreaterThanOrEqual(0);
    }, 20_000);

    it("supersedes an in-flight query without losing what it already had", async () => {
      const program = Effect.gen(function* () {
        const gate = yield* makeReconciliationGate();
        yield* gate.run("Année");

        // A typo and a correction, back to back. `run` interrupts previous work, so the
        // superseded flight stops on the wire; the retained success survives it.
        yield* applyTerm(gate, "Annéex");
        const corrected = yield* applyTerm(gate, "Année");

        expect(corrected.drafts).toHaveLength(1);
        return corrected;
      });

      const result = await run(program);
      expect(result.term).toBe("Année");
    }, 20_000);
  });
});
