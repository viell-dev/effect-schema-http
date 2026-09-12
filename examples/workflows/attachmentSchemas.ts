import { Data, Schema } from "effect";

export const Attachment = Schema.Struct({ name: Schema.NonEmptyString, bytes: Schema.Uint8ArrayFromSelf });
export const NewDocument = Schema.Struct({ title: Schema.NonEmptyString });
export const DocumentInput = Schema.Struct({
  document: NewDocument,
  attachments: Schema.Array(Attachment),
}).pipe(
  Schema.filter(({ attachments }) => new Set(attachments.map(({ name }) => name)).size === attachments.length, {
    message: () => "Attachment names must be distinct within a document",
  }),
);
export const UploadCheckpoint = Schema.Struct({
  documentId: Schema.UUID,
  completed: Schema.Array(Schema.NonEmptyString),
  pending: Schema.Array(Attachment),
}).pipe(
  Schema.filter(
    ({ completed, pending }) =>
      new Set([...completed, ...pending.map(({ name }) => name)]).size === completed.length + pending.length,
    { message: () => "Completed and pending attachment names must be distinct" },
  ),
);
export type UploadCheckpoint = typeof UploadCheckpoint.Type;

/** Expected upload failure preserves the precise underlying error and the remaining operation work. */
export class AttachmentUploadFailed<E> extends Data.TaggedError("AttachmentUploadFailed")<{
  readonly checkpoint: UploadCheckpoint;
  readonly cause: E;
}> {}
