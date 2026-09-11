import { Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { AtomFeedFromString } from "@realworld/domain";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderPostCard } from "../components/postCard.js";
import { getBlog, importBlogFeed } from "../api.js";
import { run } from "../runtime.js";
import { decodeForm } from "../decodeForm.js";
import { domainErrorMessage } from "../errors.js";
import { getSession } from "../session.js";

/**
 * Importing an Atom document is the one place in this app where a schema encodes a *request* into
 * a non-JSON format. The textarea holds XML; `decodeForm(AtomFeedFromString, ...)` turns it into
 * the same `AtomFeedData` value the feed page decodes out of the feed endpoint, and
 * `.setBody(...)` then re-encodes it to XML through `RequestBody.text` on the way out.
 *
 * Decoding here rather than posting the raw string is the point: an unparseable document is
 * rejected in the browser, with the same issue list the server would have produced, before a
 * request is made at all.
 */
const renderImportPanel = (username: string, reload: () => void): HTMLElement => {
  const xmlInput = h("textarea", { name: "atom", rows: "6", placeholder: "<feed>…</feed>" });
  const status = h("p", { class: "hint hidden" });
  // Re-rendering the page would replace this panel, and with it the summary the import just
  // produced, so reloading the post list is left to an explicit click.
  const reloadLink = h("button", { class: "link-button hidden", type: "button", onclick: () => reload() }, "Show them");

  const show = (message: string, offerReload = false): void => {
    status.textContent = message;
    status.classList.remove("hidden");
    reloadLink.classList.toggle("hidden", !offerReload);
  };

  return h(
    "form",
    {
      class: "card form",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const decoded = decodeForm(AtomFeedFromString, xmlInput.value);
        if (decoded._tag === "failure") {
          show(`That is not a feed this importer understands: ${decoded.issues.join("; ")}`);
          return;
        }

        show("Importing…");
        void run(importBlogFeed({ username }).setBody(decoded.value).pipe(toEffect))
          .then((result) => {
            const message = domainErrorMessage(result);
            if (message) {
              show(message);
              return;
            }
            Match.value(result).pipe(
              Match.tag("ok", ({ body }) => {
                show(
                  `Imported ${body.imported} post(s), skipped ${body.skipped} already present.`,
                  body.imported > 0,
                );
                xmlInput.value = "";
              }),
              Match.orElse(() => show("Unexpected response from the server.")),
            );
          })
          .catch((error: unknown) => {
            console.error("atom import failed", error);
            show("Could not reach the server. Is it running?");
          });
      },
    },
    h("h2", {}, "Import from Atom"),
    h("p", { class: "import-status" }, status, reloadLink),
    h("label", {}, "Atom document", xmlInput),
    h("button", { type: "submit" }, "Import"),
  );
};

export const renderBlogPage = async (root: HTMLElement, username: string): Promise<void> => {
  const main = h("main", { class: "container" }, h("p", {}, "Loading blog…"));
  mount(root, renderNav(), main);

  const result = await run(getBlog({ username }).pipe(toEffect)).catch((error: unknown) => {
    console.error("blog request failed", error);
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
    Match.tag("ok", ({ body }) => {
      const isOwnBlog = getSession()?.profile.id === body.profile.id;
      mount(
        main,
        h(
          "header",
          { class: "blog-header" },
          h("h1", {}, body.profile.displayName),
          h(
            "p",
            { class: "post-meta" },
            `@${body.profile.username}`,
            " · ",
            h("a", { href: `#/blog/${username}/feed` }, "Atom feed"),
          ),
          body.profile.bio ? h("p", {}, body.profile.bio) : null,
        ),
        isOwnBlog
          ? h("p", { class: "hint" }, "You are viewing your own blog — draft and private posts are included below.")
          : null,
        body.posts.length === 0
          ? h("p", { class: "empty" }, "No posts to show yet.")
          : h("div", { class: "post-list" }, ...body.posts.map(renderPostCard)),
        isOwnBlog ? renderImportPanel(username, () => void renderBlogPage(root, username)) : null,
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
