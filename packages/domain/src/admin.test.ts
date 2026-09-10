import { DateTime, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AdminStatsFromBytes } from "./admin.js";
import { NonNegativeInt } from "./primitives.js";

describe("AdminStatsFromBytes", () => {
  const sample = {
    users: NonNegativeInt.make(3),
    posts: NonNegativeInt.make(7),
    comments: NonNegativeInt.make(12),
    generatedAt: DateTime.unsafeMake("2026-01-02T03:04:05.000Z"),
  };

  it("round-trips through bytes as UTF-8 JSON", async () => {
    const bytes = await Effect.runPromise(Schema.encode(AdminStatsFromBytes)(sample));
    expect(bytes).toBeInstanceOf(Uint8Array);
    // The whole point: this "legacy" endpoint is bytes on the wire, but the bytes are just JSON text.
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"users":3,"posts":7,"comments":12,"generatedAt":"2026-01-02T03:04:05.000Z"}',
    );

    const decoded = await Effect.runPromise(Schema.decode(AdminStatsFromBytes)(bytes));
    expect(decoded.users).toBe(3);
    expect(decoded.posts).toBe(7);
    expect(decoded.comments).toBe(12);
  });

  it("fails to decode bytes that aren't valid JSON", async () => {
    const garbage = new TextEncoder().encode("not json");
    const result = await Effect.runPromise(Effect.either(Schema.decode(AdminStatsFromBytes)(garbage)));
    expect(result._tag).toBe("Left");
  });
});
