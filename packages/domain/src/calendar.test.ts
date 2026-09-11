import { DateTime, Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CalendarEntry, CalendarResponse } from "./calendar.js";

const event = {
  _tag: "event",
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  ownerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
  title: "Standup",
  startsAt: "2026-01-02T09:00:00.000Z",
  endsAt: "2026-01-02T09:15:00.000Z",
};

const repeating = {
  ...event,
  _tag: "repeating",
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
  recurrence: { frequency: "weekly", interval: 1 },
};

const assignment = {
  _tag: "assignment",
  serviceOrderId: "3f2504e0-4f89-41d3-9a0c-0305e82c3304",
  assigneeId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
  assigneeUsername: "ada",
  title: "Replace the boiler",
  customer: "Grace Hopper",
  address: "1 Navy Yard",
  scheduledFor: "2026-01-02T13:00:00.000Z",
  status: "dispatched",
};

describe("CalendarEntry", () => {
  it("decodes all three shapes from one union", async () => {
    const entries = await Effect.runPromise(
      Schema.decodeUnknown(CalendarResponse)({ entries: [event, repeating, assignment] }),
    );

    expect(entries.entries.map((entry) => entry._tag)).toEqual(["event", "repeating", "assignment"]);
  });

  it("gives each member the fields only it has", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknown(CalendarEntry)(assignment));
    if (decoded._tag !== "assignment") throw new Error("expected the assignment member");

    // Reached without a null check, because the tag already proved the shape.
    expect(decoded.address).toBe("1 Navy Yard");
    expect(decoded.customer).toBe("Grace Hopper");
    expect(DateTime.formatIso(decoded.scheduledFor)).toBe("2026-01-02T13:00:00.000Z");
  });

  it("strips fields belonging to another member rather than rejecting them", async () => {
    // Effect Schema ignores excess properties by default, so an event that arrives carrying an
    // assignment's `address` still decodes — as an event, with the stray field dropped. That is
    // the behaviour the HTTP client inherits, since it decodes without parse options, and it is
    // the safe outcome: the decoded value has exactly the fields its member declares, so nothing
    // downstream can read an `address` off an event.
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(CalendarEntry)({ ...event, address: "1 Navy Yard" }),
    );
    expect(decoded._tag).toBe("event");
    expect(Object.keys(decoded)).not.toContain("address");

    // Rejecting it outright is available, but it is a decision made per call, not per schema.
    const strict = Effect.runSync(
      Effect.either(
        Schema.decodeUnknown(CalendarEntry)({ ...event, address: "1 Navy Yard" }, { onExcessProperty: "error" }),
      ),
    );
    expect(Either.isLeft(strict)).toBe(true);
  });

  it("refuses a repeating event without its recurrence rule", () => {
    const { recurrence: _dropped, ...withoutRule } = repeating;
    const result = Effect.runSync(Effect.either(Schema.decodeUnknown(CalendarEntry)(withoutRule)));
    expect(Either.isLeft(result)).toBe(true);
  });

  it("round-trips each member back to the wire", async () => {
    for (const shape of [event, repeating, assignment]) {
      const decoded = await Effect.runPromise(Schema.decodeUnknown(CalendarEntry)(shape));
      const encoded = await Effect.runPromise(Schema.encode(CalendarEntry)(decoded));
      expect(encoded).toEqual(shape);
    }
  });
});
