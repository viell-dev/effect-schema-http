/**
 * File attachments on a post. This is the newest feature in this "long-lived backend," which is
 * why it is the one endpoint pair using multipart upload (`RequestBody.formData`) and raw-byte
 * download (`ResponseBody.uint8Array`) instead of the JSON-only style everything else here uses.
 * Metadata (this schema) and the underlying bytes are stored separately server-side — see
 * `packages/server/src/store.ts` — so the bytes never have to round-trip through JSON.
 */
import { Schema } from "effect";
import { AttachmentId, PostId } from "./ids.js";
import { AttachmentCaption, Filename, MimeType, NonNegativeInt } from "./primitives.js";

export const AttachmentView = Schema.Struct({
  id: AttachmentId,
  postId: PostId,
  filename: Filename,
  contentType: MimeType,
  size: NonNegativeInt,
  caption: Schema.optional(AttachmentCaption),
  createdAt: Schema.DateTimeUtc,
});
export type AttachmentView = typeof AttachmentView.Type;
