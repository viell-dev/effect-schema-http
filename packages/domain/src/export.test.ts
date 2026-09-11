import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PostExportFromMarkdown } from "./export.js";
import { PostBody, PostTitle } from "./post.js";
import { Slug, Username } from "./primitives.js";

describe("PostExportFromMarkdown", () => {
  const sample = {
    slug: Slug.make("hello-world"),
    title: PostTitle.make("Hello world"),
    author: Username.make("ada"),
    body: PostBody.make("First line.\n\nSecond paragraph with a --- inside it."),
  };

  it("round-trips through encode then decode", async () => {
    const markdown = await Effect.runPromise(Schema.encode(PostExportFromMarkdown)(sample));
    expect(markdown.startsWith("---\nslug: hello-world\n")).toBe(true);

    const decoded = await Effect.runPromise(Schema.decode(PostExportFromMarkdown)(markdown));
    expect(decoded).toEqual(sample);
  });

  it("keeps a body that itself contains the front-matter delimiter", async () => {
    const markdown = await Effect.runPromise(Schema.encode(PostExportFromMarkdown)(sample));
    const decoded = await Effect.runPromise(Schema.decode(PostExportFromMarkdown)(markdown));
    expect(decoded.body).toContain("--- inside it");
  });

  it("fails to decode a document without front matter", () => {
    const result = Effect.runSync(Effect.either(Schema.decode(PostExportFromMarkdown)("just some prose")));
    expect(Either.isLeft(result)).toBe(true);
  });
});
