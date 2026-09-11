/**
 * Branded UUID identifiers for every entity in the system.
 *
 * Each id is a `Schema.UUID` refined with `Schema.brand` so that a `PostId` and a `CommentId`
 * are not interchangeable at the type level even though both are plain strings at runtime.
 * A custom `arbitrary` annotation replaces the derived (filter-and-retry) generator with a
 * direct fast-check UUID generator, which is both faster and always produces valid values.
 */
import { Schema } from "effect";

const brandedUuid = <B extends string>(brand: B) =>
  Schema.UUID.pipe(
    Schema.brand(brand),
    Schema.annotations({
      identifier: brand,
      arbitrary: () => (fc) => fc.uuid().map((value) => value as never),
    }),
  );

export const UserId = brandedUuid("UserId");
export type UserId = typeof UserId.Type;

export const PostId = brandedUuid("PostId");
export type PostId = typeof PostId.Type;

export const CommentId = brandedUuid("CommentId");
export type CommentId = typeof CommentId.Type;

export const SessionToken = brandedUuid("SessionToken");
export type SessionToken = typeof SessionToken.Type;

export const AttachmentId = brandedUuid("AttachmentId");
export type AttachmentId = typeof AttachmentId.Type;

export const CalendarEntryId = brandedUuid("CalendarEntryId");
export type CalendarEntryId = typeof CalendarEntryId.Type;

export const ServiceOrderId = brandedUuid("ServiceOrderId");
export type ServiceOrderId = typeof ServiceOrderId.Type;
