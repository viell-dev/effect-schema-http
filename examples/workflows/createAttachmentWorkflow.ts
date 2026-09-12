import { Effect, Ref, Schema } from "effect";
import { createApi, RequestBody, response, ResponseBody } from "../../src/main.js";
import { AttachmentUploadFailed, DocumentInput, NewDocument, UploadCheckpoint } from "./attachmentSchemas.js";

/**
 * Example service contract: POST creates once; PUT replaces a named attachment and is safe to repeat with equal bytes.
 * Each operation owns its progress Ref. No workflow-wide retry, implicit compensation or detached child execution.
 */
export const createAttachmentWorkflow = (baseUrl: string) => {
  const api = createApi(baseUrl);
  const createDocument = api.createRequest({
    method: "POST",
    path: "/documents",
    body: NewDocument,
    responses: [response({ _tag: "created", status: 201 }, Schema.Struct({ id: Schema.UUID }))],
  });
  const upload = api.createRequest({
    method: "PUT",
    path: "/documents/:documentId/attachments/:name",
    body: RequestBody.uint8Array("application/octet-stream"),
    responses: [response({ _tag: "uploaded", status: 204 }, ResponseBody.none)],
  });

  const resume = (checkpoint: UploadCheckpoint, progress: Ref.Ref<UploadCheckpoint | undefined>) =>
    Effect.gen(function* () {
      const valid = yield* Schema.decodeUnknown(UploadCheckpoint)(checkpoint);
      let current: UploadCheckpoint = {
        ...valid,
        completed: [...valid.completed],
        pending: valid.pending.map(({ name, bytes }) => ({ name, bytes: Uint8Array.from(bytes) })),
      };
      yield* Ref.set(progress, current);
      while (current.pending.length > 0) {
        const [attachment, ...remaining] = current.pending;
        if (attachment === undefined) break;
        const next: UploadCheckpoint = {
          documentId: current.documentId,
          completed: [...current.completed, attachment.name],
          pending: remaining,
        };
        yield* Effect.uninterruptibleMask((restore) =>
          restore(
            upload({ documentId: current.documentId, name: attachment.name }).setBody(attachment.bytes).effect,
          ).pipe(
            Effect.mapError((cause) => new AttachmentUploadFailed({ checkpoint: current, cause })),
            // Publish the acknowledged step before honoring interruption at the next boundary.
            Effect.tap(() => Ref.set(progress, next)),
          ),
        );
        current = next;
      }
      return { documentId: current.documentId, uploaded: current.completed };
    });

  return {
    resume,
    create: (input: unknown, progress: Ref.Ref<UploadCheckpoint | undefined>) =>
      Effect.gen(function* () {
        // Validate all steps before creation; snapshot bytes so later form mutations do not change pending uploads.
        const valid = yield* Schema.decodeUnknown(DocumentInput)(input);
        const pending = valid.attachments.map(({ name, bytes }) => ({ name, bytes: Uint8Array.from(bytes) }));
        yield* Ref.set(progress, undefined);
        const checkpoint = yield* Effect.uninterruptibleMask((restore) =>
          restore(createDocument().setBody(valid.document).effect).pipe(
            Effect.flatMap((result) => {
              const createdCheckpoint: UploadCheckpoint = { documentId: result.body.id, completed: [], pending };
              return Ref.set(progress, createdCheckpoint).pipe(Effect.as(createdCheckpoint));
            }),
          ),
        );
        return yield* resume(checkpoint, progress);
      }),
  };
};
