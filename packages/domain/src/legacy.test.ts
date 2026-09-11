import { Effect, Either, Pretty, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LegacyLoginForm } from "./legacy.js";
import { Email, Password } from "./primitives.js";

describe("LegacyLoginForm", () => {
  it("encodes to the flat record the url-encoded request codec accepts", async () => {
    const encoded = await Effect.runPromise(
      Schema.encode(LegacyLoginForm)({
        email: Email.make("ada@example.com"),
        password: Password.make("correct horse battery"),
        grant_type: "password",
      }),
    );

    // Every value is already a string, which is what makes this schema usable with
    // `RequestBody.urlParams` without any transformation: its input is a record of coercibles.
    expect(encoded).toEqual({
      email: "ada@example.com",
      password: "correct horse battery",
      grant_type: "password",
    });
    expect(new URLSearchParams(encoded).toString()).toBe(
      "email=ada%40example.com&password=correct+horse+battery&grant_type=password",
    );
  });

  it("rejects a grant type the legacy client never sends", () => {
    const result = Effect.runSync(
      Effect.either(
        Schema.decodeUnknown(LegacyLoginForm)({
          email: "ada@example.com",
          password: "correct horse battery",
          grant_type: "client_credentials",
        }),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
  });

  it("redacts the password in pretty output, like every other Password field", () => {
    const pretty = Pretty.make(LegacyLoginForm)({
      email: Email.make("ada@example.com"),
      password: Password.make("correct horse battery"),
      grant_type: "password",
    });
    expect(pretty).not.toContain("correct horse battery");
  });
});
