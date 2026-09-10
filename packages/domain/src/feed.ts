/**
 * A per-blog Atom feed — this backend predates its JSON API and the feed endpoint was never
 * rewritten, so it is still plain XML text. `AtomFeedFromString` is a `Schema.transformOrFail`
 * pairing `Schema.String` with a plain data schema: the server calls `Schema.encode` on it to
 * *produce* the feed, and the client (through the `repo` library's `ResponseBody.text` codec)
 * calls `Schema.decode`/relies on `response()` to *parse* it back — one bidirectional schema,
 * not a pair of hand-synced encoder/decoder functions.
 *
 * @remarks
 * This intentionally does not parse general Atom or XML. It parses exactly the small, fixed
 * shape the `encode` side of this same schema emits: a `<feed>` with a `<title>`/`<updated>` pair
 * followed by zero or more `<entry>` blocks, each with `<title>`/`<link href="...">`/`<updated>`.
 * Matches the library's README's own suggestion: "A text codec followed by a `*FromString` schema
 * can parse XML, YAML, a custom JSON dialect, or another textual protocol without special support
 * from this library" — this is deliberately the narrowest possible version of that.
 */
import { ParseResult, Schema } from "effect";
import { PostTitle } from "./post.js";

export const FeedEntry = Schema.Struct({
  title: PostTitle,
  link: Schema.String,
  updated: Schema.DateTimeUtc,
});
export type FeedEntry = typeof FeedEntry.Type;

export const AtomFeedData = Schema.Struct({
  title: Schema.String,
  updated: Schema.DateTimeUtc,
  entries: Schema.Array(FeedEntry),
});
export type AtomFeedData = typeof AtomFeedData.Type;

const escapeXml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const unescapeXml = (value: string): string =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const ENTRY_PATTERN = /<entry>([\s\S]*?)<\/entry>/g;
const TITLE_PATTERN = /<title>([\s\S]*?)<\/title>/;
const UPDATED_PATTERN = /<updated>([\s\S]*?)<\/updated>/;
const LINK_PATTERN = /<link href="([^"]*)"\s*\/>/;

export const AtomFeedFromString = Schema.transformOrFail(Schema.String, AtomFeedData, {
  decode: (xml, _options, ast) => {
    const entryMatches = Array.from(xml.matchAll(ENTRY_PATTERN));
    const header = xml.slice(0, entryMatches[0]?.index ?? xml.length);
    const titleMatch = TITLE_PATTERN.exec(header);
    const updatedMatch = UPDATED_PATTERN.exec(header);
    if (!titleMatch || !updatedMatch) {
      return ParseResult.fail(
        new ParseResult.Type(ast, xml, "not a recognizable Atom feed (missing feed-level title/updated)"),
      );
    }
    return ParseResult.succeed({
      title: unescapeXml(titleMatch[1] ?? ""),
      updated: updatedMatch[1] ?? "",
      entries: entryMatches.map((match) => {
        const body = match[1] ?? "";
        return {
          title: unescapeXml(TITLE_PATTERN.exec(body)?.[1] ?? ""),
          link: unescapeXml(LINK_PATTERN.exec(body)?.[1] ?? ""),
          updated: UPDATED_PATTERN.exec(body)?.[1] ?? "",
        };
      }),
    });
  },
  encode: (data) => {
    const entriesXml = data.entries
      .map(
        (entry) =>
          `  <entry>\n    <title>${escapeXml(entry.title)}</title>\n    <link href="${escapeXml(entry.link)}"/>\n    <updated>${entry.updated}</updated>\n  </entry>`,
      )
      .join("\n");
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      `  <title>${escapeXml(data.title)}</title>`,
      `  <updated>${data.updated}</updated>`,
      entriesXml,
      "</feed>",
      "",
    ].join("\n");
    return ParseResult.succeed(xml);
  },
});
export type AtomFeedFromString = typeof AtomFeedFromString.Type;
