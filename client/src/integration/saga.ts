import type { HttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { toEffect, type UnhandledResponse } from "viell-effect-schema-http";
import { signed } from "../plans/signing.js";
import { CreateTaskInput } from "../schemas/apiServer.js";
import { createTask, deleteTask, search, uploadFileProxy } from "../services/apiClient.js";
import { uploadFile } from "../services/fileClient.js";
import { register, requestToken } from "../services/idClient.js";
import { createNotification, notifySession } from "../services/notifyClient.js";
import { FixedWidthExtract } from "../schemas/reportGateway.js";
import { fetchExtract, reportLogin } from "../services/reportClient.js";
import { setCsrfToken, setReportSession, setSession } from "../session.js";
import { tunnelMethod } from "../plans/transforms.js";
import { draftToCreateTaskInput, ExtractRecordToTaskDraft, TaskToNotification } from "./translate.js";

/**
 * The month-end reconciliation, across all five services.
 *
 * This is the flow the whole repository is built around, and it is the shape real
 * integration work takes: a value is read from one service in that service's format,
 * translated into another service's format, written, and then the write is announced to
 * a third service in a third format — with a compensating action if the announcement
 * fails, because there is no transaction spanning a Rust process, a Python process, a
 * Java process, a Perl process and a Ruby process.
 *
 *   1. Rust     sign in, get an opaque access token
 *   2. Perl     log in again, separately, because the gateway has never heard of OAuth
 *   3. Perl     read the nightly fixed-width extract (Latin-1, no delimiters)
 *   4.          translate each extract record into a task the Java server accepts
 *   5. Java     create the tasks
 *   6. Python   store the raw extract bytes over SOAP
 *   7. Java     attach the same bytes through the proxy, which re-encodes them as SOAP
 *   8. Ruby     announce it, signed and CSRF-guarded
 *   9. Java     confirm the tasks are findable
 *
 * Everything below is ordinary `Effect.gen`. The library contributes typed, decoded
 * values at each step; Effect contributes the sequencing, the error channel, and the
 * `ensuring`/`onError` compensation.
 */

/** Everything the saga produces, for a test or a view to assert on. */
export interface ReconciliationReport {
  readonly username: string;
  readonly extractedRecords: number;
  readonly controlTotal: number;
  readonly createdTaskIds: ReadonlyArray<string>;
  readonly soapFileId: string;
  readonly proxyStatus: string;
  readonly notificationText: string;
  readonly foundInSearch: number;
}

/** Narrows a response envelope inside an Effect, failing the fiber with a readable reason. */
const expect = <Envelope extends { readonly _tag: string }, const Tag extends Envelope["_tag"]>(
  envelope: Envelope,
  tag: Tag,
): Effect.Effect<Extract<Envelope, { readonly _tag: Tag }>, Error> =>
  envelope._tag === tag
    ? Effect.succeed(envelope as Extract<Envelope, { readonly _tag: Tag }>)
    : Effect.fail(
        new Error(
          `expected ${String(tag)} but the service answered ${envelope._tag}: ${JSON.stringify(
            (envelope as { readonly body?: unknown }).body,
          )}`,
        ),
      );

export const runReconciliation = (
  username: string,
  password: string,
  projectId: string,
): Effect.Effect<ReconciliationReport, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // 1. The Rust identity server. One credential, three consumers, three spellings:
    //    `Bearer` for the SOAP service, `Token` for the Java service, and nothing at all
    //    for the Perl gateway, which has its own idea of a session.
    yield* register().setBody({ username, email: `${username}@test.invalid`, password }).pipe(toEffect);
    const token = yield* requestToken()
      .setBody({ grant_type: "password", username, password })
      .pipe(toEffect, Effect.flatMap((envelope) => expect(envelope, "ok")));
    setSession({
      accessToken: token.body.access_token,
      refreshToken: token.body.refresh_token,
      tokenType: "Bearer",
      username,
    });

    // 2. The Perl gateway. A second sign-in, with the credentials in a query string,
    //    because 1999 and because two crontabs still do it this way.
    const gateway = yield* reportLogin()
      .setUrlParam("user", username)
      .setUrlParam("pass", password)
      .pipe(toEffect, Effect.flatMap((envelope) => expect(envelope, "ok")));
    const session = yield* expect(gateway.body, "session");
    setReportSession(session.session);

    // 3. The extract: Latin-1 bytes, fixed-length records, a trailer that has to
    //    reconcile. The schema checks the control total, so a truncated download fails
    //    here rather than silently importing half a month.
    const extract = yield* fetchExtract().pipe(
      toEffect,
      Effect.flatMap((envelope) => expect(envelope, "ok")),
    );

    // 4 & 5. Translate and write. The translation is a schema, so it is `Schema.decode`
    //    of one service's type into another's — not a mapping function that happens to
    //    produce the right keys.
    const toDraft = Schema.decode(ExtractRecordToTaskDraft);
    const createdTaskIds: Array<string> = [];

    for (const record of extract.body.records) {
      const draft = yield* toDraft(record);
      const input: typeof CreateTaskInput.Type = draftToCreateTaskInput(draft, projectId);
      const created = yield* createTask()
        .setBody(input)
        .pipe(toEffect, Effect.flatMap((envelope) => expect(envelope, "created")));
      createdTaskIds.push(created.body.id);
    }

    // Everything after this point can fail, and a failure has to undo the tasks: no
    // transaction spans five processes, so the compensation is written out by hand.
    const announce = Effect.gen(function* () {
      // 6. The SOAP service, with the raw extract bytes as base64 inside an XML element.
      // Re-encode the decoded extract rather than holding on to the original bytes.
      // That is the round trip the translation tests pin, running for real: if the
      // schema were lossy the file stored here would differ from the file downloaded.
      const bytes = yield* Schema.encode(FixedWidthExtract)(extract.body);
      const base64 = btoa([...bytes].map((byte) => String.fromCharCode(byte)).join(""));

      const stored = yield* uploadFile(`extract-${Date.now()}.dat`, "application/octet-stream", base64).pipe(
        toEffect,
        Effect.flatMap((envelope) => expect(envelope, "ok")),
      );
      const soapResult = yield* expect(stored.body, "ok");

      // 7. The same bytes again, this time through the Java proxy, which turns JSON into
      //    SOAP on the way and is the only path the mobile app has.
      const proxied = yield* uploadFileProxy()
        .setBody({ fileName: "extract-proxied.dat", contentType: "application/octet-stream", fileData: base64 })
        .pipe(toEffect, Effect.flatMap((envelope) => expect(envelope, "ok")));

      // 8. The Ruby service. A third credential, and the one call that has to be signed.
      const csrf = yield* notifySession().pipe(
        toEffect,
        Effect.flatMap((envelope) => expect(envelope, "ok")),
      );
      setCsrfToken(csrf.body.csrf_token);

      const notification = yield* Schema.decode(TaskToNotification)({
        id: createdTaskIds[0] ?? "",
        projectId,
        title: extract.body.records[0]?.description ?? "the extract",
        description: "",
        status: extract.body.records[0]?.status ?? "OPEN",
        assignee: username,
        priority: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const announced = yield* createNotification()
        .setBody(notification)
        .pipe(signed, toEffect, Effect.flatMap((envelope) => expect(envelope, "created")));

      // 9. Confirm the write is visible through the service's own search, which answers
      //    a bare object when it finds exactly one thing.
      const found = yield* search(extract.body.records[0]?.description ?? "").pipe(
        toEffect,
        Effect.flatMap((envelope) => expect(envelope, "ok")),
      );

      return {
        username,
        extractedRecords: extract.body.records.length,
        controlTotal: extract.body.controlTotal,
        createdTaskIds,
        soapFileId: soapResult.value.fileId,
        proxyStatus: proxied.body.status,
        notificationText: announced.body.text,
        foundInSearch: found.body.length,
      } satisfies ReconciliationReport;
    });

    // The compensation. `onError` runs for a failure *and* for an interruption, which
    // matters: a user navigating away mid-saga should not leave half an import behind.
    return yield* announce.pipe(
      Effect.onError(() =>
        Effect.forEach(
          createdTaskIds,
          (taskId) =>
            // The gateway strips DELETE, so even the rollback has to be tunnelled.
            deleteTask({ id: taskId }).pipe(tunnelMethod("DELETE"), toEffect, Effect.ignore),
          { discard: true },
        ),
      ),
    );
  });

/** The failure type the saga can produce, for callers that want to match on it. */
export type ReconciliationError = UnhandledResponse | Error;
