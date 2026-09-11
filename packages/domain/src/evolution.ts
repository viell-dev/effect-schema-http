/**
 * What happens to a shared schema when one end is redeployed and the other is not.
 *
 * This package's whole premise is that the server and the client import the same schema,
 * so a wire shape cannot drift. That is true of the *source*, and it is worth being
 * precise about what it does not cover: during any rolling deploy, and for as long as a
 * browser tab stays open, code compiled against one version of these definitions is
 * talking to code compiled against another. The schema is shared; the deployment is not.
 *
 * So the interesting question for a shared-schema project is not "do the two ends agree"
 * — they do, by construction — but "what does each kind of change do to the end that has
 * not caught up yet". The answers are in `evolution.test.ts`, and the short version is:
 *
 * - **Adding a field is safe**, because `Schema.Struct` ignores properties it does not
 *   know about. This is the property the whole model rests on and it is a *default*,
 *   which means it can be switched off by accident.
 * - **Adding a field with `onExcessProperty: "error"` is not safe.** A schema written
 *   that way turns every additive server change into a client-side decode failure.
 * - **Making a new field optional with a default is the migration tool**, and it works in
 *   both directions at once: a new client reads an old payload, and an old client ignores
 *   the new one.
 * - **Removing or renaming a field is a breaking change** and no amount of schema
 *   cleverness changes that; it needs two deploys, or a version negotiation.
 *
 * The category below is the worked example: a field this blog did not have until posts
 * needed to be filterable, added to a live system.
 */
import { Schema } from "effect";
import { PostCategory, PostView } from "./post.js";

export { PostCategory };

/**
 * The post view as it was before categories existed.
 *
 * Kept under its own name rather than deleted, because the only honest way to reason
 * about a rolling deploy is to have both shapes available to test against.
 */
export const PostViewV1 = PostView;
export type PostViewV1 = typeof PostViewV1.Type;

/**
 * The post view with a category, as the deployed schema would be written *badly*: a new
 * required field.
 *
 * A client compiled against this cannot read anything an older server sends, which is why
 * it is here as a counter-example rather than as the definition anything uses.
 */
export const PostViewV2Required = Schema.Struct({
  ...PostView.fields,
  category: PostCategory,
});
export type PostViewV2Required = typeof PostViewV2Required.Type;

/**
 * The post view with a category, written the way it should be.
 *
 * `Schema.optionalWith(..., { default })` fills the field in during decoding when the
 * payload does not carry it, so a client compiled against this reads an old server's
 * response and gets `"uncategorised"` — a real value in the domain type, not an optional
 * the rest of the application has to keep checking.
 *
 * Reusing `PostView.fields` rather than restating them is the same trick `CurrentUser`
 * uses, and it matters more here: a version that restated the fields could drift from the
 * version it is supposed to extend, which is exactly the failure this file is about.
 */
export const PostViewV2 = Schema.Struct({
  ...PostView.fields,
  category: Schema.optionalWith(PostCategory, { default: (): PostCategory => "uncategorised" }),
}).annotations({
  identifier: "PostViewV2",
  // The equivalence from `PostView` does not survive spreading `.fields`, because the
  // annotation lives on the struct rather than on its members. Restating it is the price
  // of extension by field-spread, and forgetting to would silently fall back to full
  // structural equality — which is a real trap worth naming.
  equivalence: () => (a, b) =>
    a.id === b.id && a.slug === b.slug && a.title === b.title && a.body === b.body && a.category === b.category,
});
export type PostViewV2 = typeof PostViewV2.Type;

/** The negotiated version, as it travels in a header. */
export const SchemaVersion = Schema.Literal("1", "2");
export type SchemaVersion = typeof SchemaVersion.Type;

/**
 * The version a client asks for, and what it does with what it gets.
 *
 * The header is the right place for this rather than the payload: a response rule can
 * match on it, which means the *client* picks a decoder before the body is read, and the
 * two versions never have to be a union that some later reader has to narrow.
 */
export const ACCEPT_VERSION_HEADER = "accept-version";
export const SCHEMA_VERSION_HEADER = "x-schema-version";
