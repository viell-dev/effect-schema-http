/**
 * The two oldest request formats this backend still answers, kept alive for callers nobody can
 * upgrade: a form-encoded login (the original mobile client posts
 * `application/x-www-form-urlencoded`, not JSON) and an Atom import endpoint (the blog this one
 * replaced exported Atom, and the importer was never rewritten).
 *
 * Together they are the request-side counterparts of `feed.ts`/`admin.ts`: those prove a schema
 * can *decode* a non-JSON response, these prove the same schema machinery *encodes* a non-JSON
 * request. `LegacyLoginForm` pairs with the `repo` library's `RequestBody.urlParams`, whose input
 * is a record of coercible values — which a `Schema.Struct` of strings already satisfies, with no
 * transformation at all. `AtomFeedFromString` (defined once in `feed.ts`) pairs with
 * `RequestBody.text`: the client encodes a domain value to XML and the server decodes the same
 * XML back with the very same schema, in the opposite direction from the feed endpoint.
 */
import { Schema } from "effect";
import { Email, NonNegativeInt, Password, Slug } from "./primitives.js";

export const LegacyLoginForm = Schema.Struct({
  email: Email,
  password: Password,
  /**
   * The legacy client always sends this field, always as the string `"password"`. Declaring it as
   * a literal rather than dropping it keeps the encoded body byte-identical to what that client
   * has always sent, which is the whole point of keeping the endpoint.
   */
  grant_type: Schema.Literal("password"),
});
export type LegacyLoginForm = typeof LegacyLoginForm.Type;

export const ImportSummary = Schema.Struct({
  imported: NonNegativeInt,
  skipped: NonNegativeInt,
  slugs: Schema.Array(Slug),
});
export type ImportSummary = typeof ImportSummary.Type;
