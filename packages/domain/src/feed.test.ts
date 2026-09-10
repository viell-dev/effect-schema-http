import { DateTime, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AtomFeedFromString } from "./feed.js";
import { PostTitle } from "./post.js";

describe("AtomFeedFromString", () => {
  const sample = {
    title: "Ada Lovelace",
    updated: DateTime.unsafeMake("2026-01-02T03:04:05.000Z"),
    entries: [
      {
        title: PostTitle.make("Hello & <World>"),
        link: "http://localhost/#/posts/hello-world",
        updated: DateTime.unsafeMake("2026-01-02T03:04:05.000Z"),
      },
    ],
  };

  it("round-trips through encode then decode", async () => {
    const xml = await Effect.runPromise(Schema.encode(AtomFeedFromString)(sample));
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    // Ampersands and angle brackets in a title must be escaped, or the XML would be malformed.
    expect(xml).toContain("Hello &amp; &lt;World&gt;");
    expect(xml).not.toContain("Hello & <World>");

    const decoded = await Effect.runPromise(Schema.decode(AtomFeedFromString)(xml));
    expect(decoded.title).toBe(sample.title);
    expect(decoded.entries).toHaveLength(1);
    expect(decoded.entries[0]?.title).toBe(sample.entries[0]?.title);
    expect(decoded.entries[0]?.link).toBe(sample.entries[0]?.link);
    expect(DateTime.toEpochMillis(decoded.updated)).toBe(DateTime.toEpochMillis(sample.updated));
  });

  it("round-trips an empty feed", async () => {
    const empty = { ...sample, entries: [] };
    const xml = await Effect.runPromise(Schema.encode(AtomFeedFromString)(empty));
    const decoded = await Effect.runPromise(Schema.decode(AtomFeedFromString)(xml));
    expect(decoded.entries).toHaveLength(0);
  });

  it("fails to decode text that isn't a recognizable feed", async () => {
    const result = await Effect.runPromise(Effect.either(Schema.decode(AtomFeedFromString)("<not-a-feed/>")));
    expect(result._tag).toBe("Left");
  });
});
