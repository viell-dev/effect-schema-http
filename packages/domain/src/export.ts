/**
 * One post, two representations at the same status. `GET /api/posts/:slug/export` answers with
 * JSON or Markdown depending on the request's `Accept` header, which is the case the `repo`
 * library's response rules exist for: two rules, same `200`, distinguished only by a
 * `content-type` header matcher, plus a status-predicate rule underneath them. Per the library's
 * precedence documentation, "rules with more matched headers rank first. Among rules with the same
 * number of matched headers, an exact status ranks above a status predicate" — this endpoint is
 * the one place in this project where that ordering is actually load-bearing rather than
 * decorative.
 */
import { ParseResult, Schema } from "effect";
import { PostBody, PostTitle } from "./post.js";
import { Slug, Username } from "./primitives.js";

export const PostExport = Schema.Struct({
  slug: Slug,
  title: PostTitle,
  author: Username,
  body: PostBody,
});
export type PostExport = typeof PostExport.Type;

const FRONT_MATTER = /^---\nslug: (.*)\ntitle: (.*)\nauthor: (.*)\n---\n\n([\s\S]*)$/;

/**
 * The Markdown representation, as a bidirectional transformation over the same `PostExport` data
 * rather than a separate DTO: the server encodes it to produce the document, the client decodes it
 * back through `ResponseBody.text`. One definition, both directions, same as `AtomFeedFromString`.
 */
export const PostExportFromMarkdown = Schema.transformOrFail(Schema.String, PostExport, {
  decode: (markdown, _options, ast) => {
    const match = FRONT_MATTER.exec(markdown);
    if (!match) {
      return ParseResult.fail(new ParseResult.Type(ast, markdown, "missing the expected export front matter"));
    }
    return ParseResult.succeed({
      slug: match[1] ?? "",
      title: match[2] ?? "",
      author: match[3] ?? "",
      body: match[4] ?? "",
    });
  },
  encode: (post) =>
    ParseResult.succeed(
      `---\nslug: ${post.slug}\ntitle: ${post.title}\nauthor: ${post.author}\n---\n\n${post.body}`,
    ),
});
export type PostExportFromMarkdown = typeof PostExportFromMarkdown.Type;
