import { Match } from "effect";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderPostCard } from "../components/postCard.js";
import { listFeed } from "../api.js";
import { toEffect } from "viell-effect-schema-http";
import { run } from "../runtime.js";
import { domainErrorMessage } from "../errors.js";
import { describeCacheStatus, forceFresh } from "../forceFresh.js";

export const renderFeedPage = async (root: HTMLElement, fresh = false): Promise<void> => {
  const main = h("main", { class: "container" }, h("p", {}, "Loading feed…"));
  mount(root, renderNav(), main);

  // Ordinary navigation goes through the edge cache; only the reader asking for a refresh opts
  // out of it. Both calls are the same endpoint — the difference is one composable transform.
  const plan = fresh ? listFeed().pipe(forceFresh) : listFeed();

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
    Match.tag("ok", ({ body, headers }) => {
      mount(
        main,
        h("h1", {}, "Public feed"),
        h(
          "p",
          { class: "hint" },
          describeCacheStatus(headers),
          " · ",
          h(
            "button",
            { class: "link-button", onclick: () => void renderFeedPage(root, true) },
            "Force refresh",
          ),
        ),
        body.posts.length === 0
          ? h("p", { class: "empty" }, "No public posts yet. Be the first to write one!")
          : h("div", { class: "post-list" }, ...body.posts.map(renderPostCard)),
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
