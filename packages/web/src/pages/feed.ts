import { Match } from "effect";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderPostCard } from "../components/postCard.js";
import { listFeed } from "../api.js";
import { toEffect } from "viell-effect-schema-http";
import { run } from "../runtime.js";
import { domainErrorMessage } from "../errors.js";

export const renderFeedPage = async (root: HTMLElement): Promise<void> => {
  const main = h("main", { class: "container" }, h("p", {}, "Loading feed…"));
  mount(root, renderNav(), main);

  const result = await run(listFeed().pipe(toEffect)).catch((error: unknown) => {
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
    Match.tag("ok", ({ body }) => {
      mount(
        main,
        h("h1", {}, "Public feed"),
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
