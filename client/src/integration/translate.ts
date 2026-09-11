import { DateTime, ParseResult, Schema } from "effect";
import { CreateTaskInput, FileProxyUploadInput, Task, TaskStatusString } from "../schemas/apiServer.js";
import { Cents } from "../schemas/apiLegacy.js";
import { DirectoryEntry } from "../schemas/idLegacy.js";
import { FileItem } from "../schemas/fileServer.js";
import { CreateNotification } from "../schemas/notifyService.js";
import { ExtractRecord } from "../schemas/reportGateway.js";

/**
 * The translation layer.
 *
 * This file is the reason the repository exists.
 *
 * In its sibling project, one package of schemas is imported by both the server and the
 * client, so a value read from an endpoint is *already* the value another endpoint
 * accepts, and there is nothing to align. Here there are five services in five languages
 * that have never agreed on anything, and every one of them defines its own shape for
 * facts the others also hold. Moving a value from one to another is real work, and the
 * question this project set out to answer is where that work should live.
 *
 * The answer is: in a `Schema.transform` between two *type* schemas, not in a mapping
 * function. Three things follow from that choice, and none of them follow from a plain
 * function:
 *
 * 1. **It runs backwards.** A transform that produces a Java task draft from a report
 *    record also produces the report record from the draft, which is what makes the
 *    round-trip tests in `integration.test.ts` possible at all — and a round trip is the
 *    only evidence that a mapping is not quietly lossy.
 * 2. **Drift is a compile error.** The target is the other service's own schema, so
 *    renaming a field on either side fails the build here rather than producing a
 *    request the other service rejects at runtime.
 * 3. **It composes with the codecs.** `decode` on one service's wire form, this
 *    transform, and `encode` into the other's wire form are three steps of one
 *    pipeline, and each one is a schema.
 *
 * Where a translation genuinely cannot run backwards, it says so with a failing encode
 * rather than pretending — see `TaskToNotification`.
 */

// ---------------------------------------------------------------------------
// Report gateway -> API server
// ---------------------------------------------------------------------------

/** The part of a task the reporting extract can actually determine. */
export const TaskDraft = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  status: TaskStatusString,
  priority: Schema.Number,
});
export type TaskDraft = typeof TaskDraft.Type;

/**
 * A record from the 1999 nightly extract, as a task the 2014 API server would accept.
 *
 * The two systems share an enum — the extract is a dump of the API server's own table,
 * so `status` means the same thing on both sides and is carried across unchanged. They
 * share nothing else:
 *
 * - The extract's `id` (`T0000001`) is from a different id space than the API server's
 *   (`1a0915522db-1`). Pretending they are the same identifier is the single most
 *   tempting mistake here and it would silently corrupt both systems, so the reference
 *   is carried in the description where it is visibly a *reference* and not an id.
 * - The extract carries money and the API server has no money field at all. It becomes
 *   a priority band, which is lossy, so the exact figure is written into the description
 *   too — which is what makes the transform reversible.
 * - The extract's `active` flag has no counterpart. A cancelled-but-active row and a
 *   cancelled-but-inactive row are the same task, so the flag is recovered from the
 *   status on the way back.
 */
export const ExtractRecordToTaskDraft = Schema.transform(Schema.typeSchema(ExtractRecord), TaskDraft, {
  strict: true,
  decode: (record) => ({
    title: record.description,
    description: `Imported from the nightly extract (ref ${record.id}, ${(record.amount / 100).toFixed(2)})`,
    status: record.status,
    // Four bands, so the arithmetic is reversible from the description's figure rather
    // than from the band itself.
    priority: record.amount >= 1_000_000 ? 4 : record.amount >= 100_000 ? 3 : record.amount > 0 ? 2 : 1,
  }),
  encode: (draft) => {
    const reference = /ref ([A-Z0-9]+), ([\d.]+)/u.exec(draft.description);
    return {
      id: reference?.[1] ?? "UNKNOWN",
      description: draft.title,
      status: draft.status,
      date: DateTime.unsafeMake(0),
      amount: Cents.make(Math.round(Number(reference?.[2] ?? "0") * 100)),
      active: draft.status !== "CANCELLED",
    };
  },
});

/** Completes a draft into the exact body `POST /api/tasks` accepts. */
export const draftToCreateTaskInput = (draft: TaskDraft, projectId: string): typeof CreateTaskInput.Type => ({
  projectId,
  title: draft.title,
  description: draft.description,
  status: draft.status,
  priority: draft.priority,
});

// ---------------------------------------------------------------------------
// File server -> API server
// ---------------------------------------------------------------------------

/**
 * A file the SOAP service holds, as the upload the API server's proxy accepts.
 *
 * The SOAP service describes a file with a US-formatted local timestamp and a size; the
 * API server's proxy wants a name, a media type and base64 bytes, and has no field for
 * either of the other two. So this deliberately does *not* take a `FileItem` and produce
 * an upload — that would drop the timestamp on the floor silently.
 *
 * Instead the bytes are a parameter and the timestamp is preserved by putting it in the
 * file name, which is what the archive's own naming convention already does. A caller
 * reading this can see what survives the trip and what does not.
 */
export const fileItemToUpload = (
  item: FileItem,
  bytes: Uint8Array,
): typeof FileProxyUploadInput.Type => {
  const stamp = DateTime.formatIso(item.lastModified).slice(0, 10).replace(/-/gu, "");
  const binary = [...bytes].map((byte) => String.fromCharCode(byte)).join("");
  return {
    fileName: `${stamp}-${item.name}`,
    contentType: item.contentType,
    fileData: btoa(binary),
  };
};

/** What survived the trip, so a test can assert on it rather than on a comment. */
export const uploadLosesTimestamp = (item: FileItem, upload: typeof FileProxyUploadInput.Type): boolean =>
  !Object.values(upload).some((value) => typeof value === "number") &&
  upload.fileName.startsWith(DateTime.formatIso(item.lastModified).slice(0, 10).replace(/-/gu, ""));

// ---------------------------------------------------------------------------
// API server -> Notify service
// ---------------------------------------------------------------------------

/**
 * A task, as a notification.
 *
 * This one is honestly one-way. A notification is a sentence for a human, and no
 * arrangement of words recovers a task's id, project, assignee or timestamps. Rather
 * than write an `encode` that fabricates a plausible task, it fails with a message
 * saying why — which is a real answer to "should this be a transform or a function?"
 * The transform is still worth having, because decoding stays a schema and composes
 * with the rest of the pipeline; only the reverse direction is genuinely unavailable.
 */
export const TaskToNotification = Schema.transformOrFail(Schema.typeSchema(Task), CreateNotification, {
  strict: true,
  decode: (task) =>
    ParseResult.succeed({
      kind: "assignment" as const,
      text:
        task.assignee === ""
          ? `"${task.title}" is unassigned and now ${task.status.toLowerCase().replace("_", " ")}`
          : `"${task.title}" is assigned to ${task.assignee} and now ${task.status.toLowerCase().replace("_", " ")}`,
    }),
  encode: (notification, _options, ast) =>
    ParseResult.fail(
      new ParseResult.Type(
        ast,
        notification,
        "a notification is prose for a person; it cannot be turned back into a task",
      ),
    ),
});

// ---------------------------------------------------------------------------
// ID server -> API server
// ---------------------------------------------------------------------------

/**
 * A directory entry, as an assignee the API server will accept.
 *
 * The API server stores an assignee as a bare username string with no validation at all,
 * so this is where the check has to happen: a blank username or an inactive account
 * cannot be assigned work, and the failure belongs at the boundary rather than three
 * screens later when someone notices a task nobody can see.
 */
export const DirectoryEntryToAssignee = Schema.transformOrFail(
  Schema.typeSchema(DirectoryEntry),
  Schema.String.pipe(Schema.minLength(1)),
  {
    strict: true,
    decode: (entry, _options, ast) =>
      entry.active
        ? ParseResult.succeed(entry.username)
        : ParseResult.fail(new ParseResult.Type(ast, entry, `${entry.username} is not an active account`)),
    encode: (username) =>
      ParseResult.succeed({
        id: null,
        username,
        email: null,
        displayName: null,
        createdAt: null,
        active: true,
      }),
  },
);
