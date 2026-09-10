import { Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderPostCard } from "../components/postCard.js";
import { getBlog } from "../api.js";
import { run } from "../runtime.js";
import { withAuth } from "../withAuth.js";
import { domainErrorMessage } from "../errors.js";
import { getSession } from "../session.js";

export const renderBlogPage = async (root: HTMLElement, username: string): Promise<void> => {
  const main = h("main", { class: "container" }, h("p", {}, "Loading blog…"));
  mount(root, renderNav(), main);

  const result = await run(withAuth(getBlog({ username })).pipe(toEffect)).catch((error: unknown) => {
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
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
