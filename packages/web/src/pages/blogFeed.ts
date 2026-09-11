/**
 * Renders the same Atom feed a feed reader would consume, but through this app: fetched with
 * `ResponseBody.text` and decoded by `AtomFeedFromString` (a `Schema.transformOrFail` pairing
 * `Schema.String` with a plain data schema — see `packages/domain/src/feed.ts`), not by any
 * XML-aware library.
 */
import { DateTime, Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { getBlogFeed } from "../api.js";
import { run } from "../runtime.js";
import { domainErrorMessage } from "../errors.js";
import { describeCacheStatus, forceFresh } from "../forceFresh.js";

export const renderBlogFeedPage = async (root: HTMLElement, username: string, fresh = false): Promise<void> => {
  const main = h("main", { class: "container" }, h("p", {}, "Loading feed…"));
  mount(root, renderNav(), main);

  // The same transform as the public feed, applied to an endpoint with a completely different
  // response shape: this one decodes XML through `ResponseBody.text`, the other decodes JSON.
  const plan = fresh ? getBlogFeed({ username }).pipe(forceFresh) : getBlogFeed({ username });

  const result = await run(plan.pipe(toEffect)).catch((error: unknown) => {
    console.error("feed request failed", error);
    return undefined;
  });

  if (!result) {
    mount(main, h("p", { class: "error" }, "Could not reach the server. Is it running?"));
    return;
  }

  const errorMessage = domainErrorMessage(result);
  if (errorMessage) {
    mount(main, h("p", { class: "error" }, errorMessage));
    return;
  }

  Match.value(result).pipe(
    Match.tag("ok", ({ body: feed, headers }) => {
      mount(
        main,
        h("h1", {}, `${feed.title}'s feed`),
        h(
          "p",
          { class: "hint" },
          `Parsed from Atom/XML served with a text/atom+xml content-type — fetched via ResponseBody.text, not JSON. `,
          h("a", { href: `#/blog/${username}` }, "Back to the blog"),
          " · ",
          describeCacheStatus(headers),
          " · ",
          h(
            "button",
            { class: "link-button", onclick: () => void renderBlogFeedPage(root, username, true) },
            "Force refresh",
          ),
        ),
        feed.entries.length === 0
          ? h("p", { class: "empty" }, "No public entries yet.")
          : h(
              "div",
              { class: "post-list" },
              ...feed.entries.map((entry) =>
                h(
                  "article",
                  { class: "feed-entry" },
                  h("a", { class: "post-title", href: entry.link }, entry.title),
                  h("p", { class: "post-meta" }, new Date(DateTime.toEpochMillis(entry.updated)).toLocaleString()),
                ),
              ),
            ),
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
