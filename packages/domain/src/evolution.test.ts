import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PostCategory, PostViewV1, PostViewV2, PostViewV2Required } from "./evolution.js";
import { PostView } from "./post.js";

/**
 * Rolling-deploy behaviour, pinned.
 *
 * Every case here is a deploy that either is or is not safe, and the difference is
 * usually one word in a schema definition. A project that shares its schemas between both
 * ends gets a great deal for free and can still break itself in about four characters.
 */

const encodedV1 = {
  id: "8f1b1e1e-7b1a-4f6a-9a44-38c4a5a2f1aa",
  authorId: "2a6f4e6d-8d2b-4b76-9c76-24b41ad00a11",
  authorUsername: "ada",
  slug: "a-post-about-schemas",
  title: "A post about schemas",
  body: "Schemas are the contract.",
  visibility: "public",
  revision: 3,
  commentCount: 2,
  createdAt: "2026-09-11T10:00:00.000Z",
  updatedAt: "2026-09-11T10:05:00.000Z",
};

const encodedV2 = { ...encodedV1, category: "engineering" };

describe("adding a field", () => {
  it("does not break a client compiled against the older schema", () => {
    // The single most important property in this whole project, and it is a *default*:
    // `Schema.Struct` ignores properties it was not told about. Every additive server
    // change is therefore backwards compatible without anyone doing anything.
    const decoded = Schema.decodeUnknownSync(PostViewV1)(encodedV2);

    expect(decoded.slug).toBe("a-post-about-schemas");
    expect(Object.hasOwn(decoded, "category")).toBe(false);
  });

  it("breaks it immediately if the schema was told to reject excess properties", () => {
    // Four characters of configuration turn every future additive deploy into a
    // client-side outage. `onExcessProperty: "error"` is the right setting for parsing a
    // *config file*, where a typo should be loud, and the wrong one for a wire format
    // whose other end will grow fields.
    expect(() =>
      Schema.decodeUnknownSync(PostViewV1)(encodedV2, { onExcessProperty: "error" }),
    ).toThrow();
  });

  it("breaks a new client reading an old server when the field is required", () => {
    // The mirror image, and the more common outage: the client ships first, or the
    // rollout is partial, and half the servers are still sending the old shape.
    expect(() => Schema.decodeUnknownSync(PostViewV2Required)(encodedV1)).toThrow();
    expect(Schema.decodeUnknownSync(PostViewV2Required)(encodedV2).category).toBe("engineering");
  });

  it("works in both directions at once when the field has a default", () => {
    // `Schema.optionalWith(..., { default })` is the whole migration. A new client reads
    // an old payload and gets a real value, not an `undefined` that every call site has
    // to check; an old client reads a new payload and ignores the field.
    const fromOld = Schema.decodeUnknownSync(PostViewV2)(encodedV1);
    const fromNew = Schema.decodeUnknownSync(PostViewV2)(encodedV2);

    expect(fromOld.category).toBe("uncategorised");
    expect(fromNew.category).toBe("engineering");

    // And it is still one round trip: encoding a defaulted value writes the field out.
    expect(Schema.encodeSync(PostViewV2)(fromOld)).toMatchObject({ category: "uncategorised" });
  });
});

describe("removing or renaming a field", () => {
  it("breaks the end that still expects it, and nothing in the schema can help", () => {
    const { commentCount: _removed, ...withoutCommentCount } = encodedV1;

    // There is no defaulting a field the payload no longer has *meaning* for. A default
    // would be a fabricated number, which is worse than a failure.
    expect(() => Schema.decodeUnknownSync(PostViewV1)(withoutCommentCount)).toThrow();
  });

  it("can be survived by renaming in the schema, for exactly one deploy", () => {
    // `Schema.rename` maps a wire name onto a domain name, which buys one deploy: the
    // server can start sending `comments` while clients still call it `commentCount`.
    // Both names have to be accepted during the overlap, which a union of two structs
    // expresses honestly — and which is why a rename costs three deploys rather than one.
    const Renamed = Schema.Struct({
      ...PostView.fields,
      commentCount: Schema.propertySignature(PostView.fields.commentCount).pipe(Schema.fromKey("comments")),
    });

    const decoded = Schema.decodeUnknownSync(Renamed)({
      ...Object.fromEntries(Object.entries(encodedV1).filter(([key]) => key !== "commentCount")),
      comments: 2,
    });

    expect(decoded.commentCount).toBe(2);
    // The encoded form goes back out under the wire name, so the rename is invisible to
    // everything above the schema.
    expect(Schema.encodeSync(Renamed)(decoded)).toMatchObject({ comments: 2 });
  });
});

describe("what a version literal is worth", () => {
  it("refuses a category the deployed schema has never heard of", () => {
    // The counterpart risk to an added field: an added *enum member*. A newer server
    // sending `category: "legal"` breaks every older client, because a literal union is
    // closed. That is usually the right trade — an unknown category cannot be rendered
    // anyway — but it means enum growth is a breaking change even though field growth is
    // not, which is not obvious and catches people.
    expect(() => Schema.decodeUnknownSync(PostCategory)("legal")).toThrow();

    // The escape is to decide, at design time, that unknown members become a known one.
    const Lenient = Schema.transform(Schema.String, PostCategory, {
      strict: true,
      decode: (value) =>
        (["engineering", "operations", "announcement", "uncategorised"] as const).includes(value as PostCategory)
          ? (value as PostCategory)
          : "uncategorised",
      encode: (value) => value,
    });
    expect(Schema.decodeUnknownSync(Lenient)("legal")).toBe("uncategorised");
  });
});
