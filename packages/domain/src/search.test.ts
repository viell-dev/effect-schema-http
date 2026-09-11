import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { paginationFromHeaders, SearchHit, SearchHits, SearchTags } from "./search.js";

describe("SearchTags", () => {
  it("accepts one tag as a bare string and several as an array", async () => {
    const one = await Effect.runPromise(Schema.decodeUnknown(SearchTags)("blog"));
    const many = await Effect.runPromise(Schema.decodeUnknown(SearchTags)(["blog", "archive"]));
    expect(one).toEqual(["blog"]);
    expect(many).toEqual(["blog", "archive"]);
  });

  it("reproduces the vendor's inconsistency when encoding", async () => {
    expect(await Effect.runPromise(Schema.encode(SearchTags)(["blog"]))).toBe("blog");
    expect(await Effect.runPromise(Schema.encode(SearchTags)(["blog", "archive"]))).toEqual(["blog", "archive"]);
  });
});

describe("SearchHit", () => {
  it("turns the vendor's stringly-typed fields into ordinary values", async () => {
    const hit = await Effect.runPromise(
      Schema.decodeUnknown(SearchHit)({
        slug: "hello-world",
        title: "Hello world",
        tags: "blog",
        score: "0.87",
        is_public: "1",
      }),
    );

    expect(hit.score).toBe(0.87);
    expect(hit.is_public).toBe(true);
    expect(hit.tags).toEqual(["blog"]);
  });

  it("rejects a boolean the vendor would never send", () => {
    const result = Effect.runSync(
      Effect.either(
        Schema.decodeUnknown(SearchHit)({
          slug: "hello-world",
          title: "Hello world",
          tags: [],
          score: "0.5",
          is_public: "true",
        }),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
  });

  it("decodes a page of mixed-shape hits", async () => {
    const hits = await Effect.runPromise(
      Schema.decodeUnknown(SearchHits)([
        { slug: "a", title: "A", tags: "blog", score: "1", is_public: "1" },
        { slug: "b", title: "B", tags: ["blog", "archive"], score: "0.5", is_public: "0" },
      ]),
    );
    expect(hits.map((hit) => hit.tags.length)).toEqual([1, 2]);
    expect(hits.map((hit) => hit.is_public)).toEqual([true, false]);
  });
});

describe("paginationFromHeaders", () => {
  it("reads the vendor's pagination out of response fields", async () => {
    const pagination = await Effect.runPromise(
      Schema.decodeUnknown(paginationFromHeaders)({ "x-total-count": "42", "x-page": "2", "x-per-page": "5" }),
    );
    expect(pagination).toEqual({ total: 42, page: 2, perPage: 5 });
  });

  it("fails loudly when the proxy drops a field instead of guessing", () => {
    const result = Effect.runSync(
      Effect.either(Schema.decodeUnknown(paginationFromHeaders)({ "x-page": "1", "x-per-page": "5" })),
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});
