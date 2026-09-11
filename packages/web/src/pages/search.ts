/**
 * The search page, and the one page in this app that has to cope with an API it does not control.
 *
 * Three things happen here that happen nowhere else: the result count comes out of response
 * *headers* rather than the body, "no results" arrives as a different response rule than "some
 * results", and the vendor's stringly-typed fields (`score`, `is_public`, a `tags` field that is
 * sometimes a string) are already ordinary values by the time they reach this file, because the
 * schemas in `@realworld/domain/search` absorbed them at the edge.
 */
import { Effect, Match, Schema } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { paginationFromHeaders, type SearchHit, type SearchPagination } from "@realworld/domain";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { search } from "../api.js";
import { run } from "../runtime.js";
import { domainErrorMessage } from "../errors.js";

const readPagination = (headers: Readonly<Record<string, string>>): SearchPagination | undefined =>
  Schema.decodeUnknownOption(paginationFromHeaders)(headers).pipe(
    (option) => (option._tag === "Some" ? option.value : undefined),
  );

const renderHit = (hit: SearchHit): HTMLElement =>
  h(
    "article",
    { class: "feed-entry" },
    h("a", { class: "post-title", href: `#/posts/${hit.slug}` }, hit.title),
    h(
      "p",
      { class: "post-meta" },
      `score ${hit.score.toFixed(2)}`,
      hit.is_public ? " · public" : " · restricted",
      hit.tags.length > 0 ? ` · ${hit.tags.join(", ")}` : "",
    ),
  );

export const renderSearchPage = (root: HTMLElement): void => {
  const queryInput = h("input", { type: "search", name: "q", placeholder: "Search posts" });
  const status = h("p", { class: "hint hidden" });
  const results = h("div", { class: "post-list" });

  let page = 1;

  const show = (message: string) => {
    status.textContent = message;
    status.classList.remove("hidden");
  };

  const load = async (): Promise<void> => {
    show("Searching…");
    results.replaceChildren();

    const result = await run(
      search().setUrlParam("q", () => queryInput.value.trim() || undefined).setUrlParam("page", String(page)).pipe(toEffect),
    );

    const message = domainErrorMessage(result);
    if (message) {
      show(message);
      return;
    }

    const pagination = readPagination(result.headers);

    Match.value(result).pipe(
      // The empty case is its own rule, so there is no "did the parse fail or was it just empty?"
      // ambiguity to resolve here — the two are different values.
      Match.tag("empty", () => {
        show(pagination ? `No matches (the vendor searched ${pagination.total} indexed posts).` : "No matches.");
      }),
      Match.tag("hits", ({ body }) => {
        const summary = pagination
          ? `${pagination.total} match(es), page ${pagination.page} of ${Math.max(
              1,
              Math.ceil(pagination.total / pagination.perPage),
            )}`
          : `${body.length} match(es) (the vendor omitted its pagination fields)`;
        show(summary);
        results.replaceChildren(...body.map(renderHit));
      }),
      Match.tag("rateLimited", ({ body }) => {
        // Only reached once the endpoint's retry policy has given up.
        show(`${body.message} — the retries ran out. Try again in a moment.`);
      }),
      Match.orElse(() => show("Unexpected response from the search service.")),
    );
  };

  const submit = (event: Event) => {
    event.preventDefault();
    page = 1;
    void load().catch((error: unknown) => {
      console.error("search failed", error);
      show("Could not reach the search service.");
    });
  };

  const form = h(
    "form",
    { class: "card form", onsubmit: submit },
    h("h1", {}, "Search"),
    h(
      "p",
      { class: "hint" },
      "Search is a vendor product behind a proxy rule: pagination arrives in response headers, " +
        "no results means an empty body rather than an empty array, and it rate-limits after a " +
        "short burst.",
    ),
    h("label", {}, "Query", queryInput),
    h(
      "div",
      { class: "button-row" },
      h("button", { type: "submit" }, "Search"),
      h(
        "button",
        {
          type: "button",
          class: "secondary",
          onclick: () => {
            page += 1;
            void load().catch(() => show("Could not reach the search service."));
          },
        },
        "Next page",
      ),
    ),
  );

  mount(root, renderNav(), h("main", { class: "container" }, form, status, results));
};
