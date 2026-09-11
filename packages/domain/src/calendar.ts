/**
 * The worker calendar, and the one part of this API that is not badly behaved at all.
 *
 * It exists to make a point the rest of the project cannot: a response body that is one of several
 * shapes is *normal*, and has nothing to do with an API being old or sloppy. A worker's calendar
 * legitimately contains three different things:
 *
 * - a **single event** — an ordinary appointment someone put in the calendar;
 * - a **repeating event** — the same, plus a recurrence rule, so it is a genuinely different shape
 *   rather than the same shape with nullable fields;
 * - an **assignment** — not a calendar entry at all in the database, but a service order from a
 *   different resource entirely, projected onto the calendar because the worker has to see where
 *   they are expected to be. It carries the order it came from, a customer, and an address, none
 *   of which a calendar event has or should have.
 *
 * All three are a correct `200` on the same endpoint. The transport cannot tell them apart —
 * status and headers are identical — so the distinction lives where it belongs, in the schema, as
 * a `_tag`-discriminated `Schema.Union`. The client's response rule matches the envelope; the
 * client's `Match.tag` over `body` matches the value. Two layers, each exhaustive, neither
 * standing in for the other.
 *
 * Modelling the alternative would be worse in every way: one flat struct with `recurrence?`,
 * `serviceOrderId?`, `customer?` and `address?` all optional, and no way for the compiler to know
 * that an assignment always has an address and an event never does.
 */
import { Schema } from "effect";
import { CalendarEntryId, ServiceOrderId, UserId } from "./ids.js";
import { DisplayName, NonZeroPositiveInt, Username } from "./primitives.js";

export const CalendarTitle = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(160),
  Schema.brand("CalendarTitle"),
);
export type CalendarTitle = typeof CalendarTitle.Type;

export const StreetAddress = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(240),
  Schema.brand("StreetAddress"),
);
export type StreetAddress = typeof StreetAddress.Type;

export const RecurrenceFrequency = Schema.Literal("daily", "weekly", "monthly");
export type RecurrenceFrequency = typeof RecurrenceFrequency.Type;

export const Recurrence = Schema.Struct({
  frequency: RecurrenceFrequency,
  interval: NonZeroPositiveInt,
  until: Schema.optional(Schema.DateTimeUtc),
});
export type Recurrence = typeof Recurrence.Type;

export const SingleEvent = Schema.Struct({
  _tag: Schema.Literal("event"),
  id: CalendarEntryId,
  ownerId: UserId,
  title: CalendarTitle,
  startsAt: Schema.DateTimeUtc,
  endsAt: Schema.DateTimeUtc,
});
export type SingleEvent = typeof SingleEvent.Type;

export const RepeatingEvent = Schema.Struct({
  _tag: Schema.Literal("repeating"),
  id: CalendarEntryId,
  ownerId: UserId,
  title: CalendarTitle,
  startsAt: Schema.DateTimeUtc,
  endsAt: Schema.DateTimeUtc,
  recurrence: Recurrence,
});
export type RepeatingEvent = typeof RepeatingEvent.Type;

/**
 * Projected from a service order rather than stored as a calendar entry, which is why its id is
 * the *order's* id: there is nothing else to point at, and a worker who taps it expects to land on
 * the order, not on a calendar record that does not exist.
 */
export const AssignmentEntry = Schema.Struct({
  _tag: Schema.Literal("assignment"),
  serviceOrderId: ServiceOrderId,
  assigneeId: UserId,
  assigneeUsername: Username,
  title: CalendarTitle,
  customer: DisplayName,
  address: StreetAddress,
  scheduledFor: Schema.DateTimeUtc,
  status: Schema.Literal("dispatched", "accepted", "completed"),
});
export type AssignmentEntry = typeof AssignmentEntry.Type;

export const CalendarEntry = Schema.Union(SingleEvent, RepeatingEvent, AssignmentEntry);
export type CalendarEntry = typeof CalendarEntry.Type;

export const CalendarResponse = Schema.Struct({
  entries: Schema.Array(CalendarEntry),
});
export type CalendarResponse = typeof CalendarResponse.Type;

export const CreateEventInput = Schema.Struct({
  title: CalendarTitle,
  startsAt: Schema.DateTimeUtc,
  endsAt: Schema.DateTimeUtc,
  recurrence: Schema.optional(Recurrence),
});
export type CreateEventInput = typeof CreateEventInput.Type;

export const CreateServiceOrderInput = Schema.Struct({
  assignee: Username,
  title: CalendarTitle,
  customer: DisplayName,
  address: StreetAddress,
  scheduledFor: Schema.DateTimeUtc,
});
export type CreateServiceOrderInput = typeof CreateServiceOrderInput.Type;
