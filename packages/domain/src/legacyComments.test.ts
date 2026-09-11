import { DateTime, Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DateTimeUtcFromEpochSeconds, LegacyCommentResponse } from "./legacyComments.js";

describe("DateTimeUtcFromEpochSeconds", () => {
  it("reads seconds, not milliseconds", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknown(DateTimeUtcFromEpochSeconds)(1_767_225_600));
    expect(DateTime.formatIso(decoded)).toBe("2026-01-01T00:00:00.000Z");
    // The reading this schema exists to prevent: `new Date(1767225600)` is in 1970.
    expect(new Date(1_767_225_600).getUTCFullYear()).toBe(1970);
  });

  it("round-trips back to seconds", async () => {
    const value = DateTime.unsafeMake("2026-01-02T03:04:05.000Z");
    const encoded = await Effect.runPromise(Schema.encode(DateTimeUtcFromEpochSeconds)(value));
    expect(encoded).toBe(1_767_323_045);
    const decoded = await Effect.runPromise(Schema.decodeUnknown(DateTimeUtcFromEpochSeconds)(encoded));
    expect(DateTime.toEpochMillis(decoded)).toBe(DateTime.toEpochMillis(value));
  });
});

describe("LegacyCommentResponse", () => {
  it("decodes the success shape, converting the epoch timestamp", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(LegacyCommentResponse)({
        status: "ok",
        comment_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        created_at: 1_767_225_600,
      }),
    );

    expect(decoded.status).toBe("ok");
    if (decoded.status !== "ok") throw new Error("expected the ok member");
    expect(DateTime.formatIso(decoded.created_at)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("decodes the failure shape, which arrives at the same 200 status", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(LegacyCommentResponse)({
        status: "error",
        error_code: "not_found",
        error_message: "no post named nope",
      }),
    );

    expect(decoded.status).toBe("error");
    if (decoded.status !== "error") throw new Error("expected the error member");
    expect(decoded.error_code).toBe("not_found");
  });

  it("rejects an error code nobody has ever seen this endpoint send", () => {
    const result = Effect.runSync(
      Effect.either(
        Schema.decodeUnknown(LegacyCommentResponse)({
          status: "error",
          error_code: "teapot",
          error_message: "?",
        }),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});
