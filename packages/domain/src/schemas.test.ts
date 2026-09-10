import { Arbitrary, DateTime, FastCheck, Pretty, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { NonZeroPositiveInt, Password, Slug, Username, Email } from "./primitives.js";
import { PostView } from "./post.js";
import { UserId } from "./ids.js";

const checkArbitraryIsValid = <A, I>(name: string, schema: Schema.Schema<A, I>) => {
  it(name, () => {
    const arbitrary = Arbitrary.make(schema);
    const samples = FastCheck.sample(arbitrary, 50);
    for (const value of samples) {
      expect(Schema.is(schema)(value), `${name} generated an invalid value: ${JSON.stringify(value)}`).toBe(true);
    }
  });
};

describe("branded primitives: custom arbitrary always satisfies the schema", () => {
  checkArbitraryIsValid("Username", Username);
  checkArbitraryIsValid("Email", Email);
  checkArbitraryIsValid("Slug", Slug);
  checkArbitraryIsValid("Password", Password);
  checkArbitraryIsValid("NonZeroPositiveInt", NonZeroPositiveInt);
  checkArbitraryIsValid("UserId", UserId);
});

describe("Password pretty annotation", () => {
  it("redacts the value instead of printing it", () => {
    const pretty = Pretty.make(Password);
    const value = Password.make("hunter2hunter2");
    expect(pretty(value)).toBe("Password(<redacted>)");
    expect(pretty(value)).not.toContain("hunter2");
  });
});

describe("PostView custom equivalence", () => {
  const equivalence = Schema.equivalence(PostView);
  const arbitrary = Arbitrary.make(PostView);

  const sampleOne = (): typeof PostView.Type => {
    const sample = FastCheck.sample(arbitrary, 1)[0];
    if (!sample) throw new Error("fast-check produced no sample");
    return sample;
  };

  it("ignores createdAt/updatedAt differences", () => {
    const original = sampleOne();
    const later = { ...original, updatedAt: DateTime.addDuration(original.updatedAt, "1 hours") };
    expect(equivalence(original, later)).toBe(true);
  });

  it("still distinguishes different content", () => {
    const original = sampleOne();
    const changed = { ...original, commentCount: (original.commentCount + 1) as typeof original.commentCount };
    expect(equivalence(original, changed)).toBe(false);
  });
});
