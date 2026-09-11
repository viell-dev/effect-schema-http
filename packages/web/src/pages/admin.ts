import { DateTime, Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderUsersDirectory } from "../components/usersDirectory.js";
import { adminRefreshCache, adminStats } from "../api.js";
import { run } from "../runtime.js";
import { withAuth } from "../withAuth.js";
import { domainErrorMessage } from "../errors.js";
import { getSession } from "../session.js";

export const renderAdminPage = async (root: HTMLElement): Promise<void> => {
  const session = getSession();
  if (!session || session.role !== "admin") {
    mount(root, renderNav(), h("main", { class: "container" }, h("p", { class: "error" }, "Admins only.")));
    return;
  }

  const main = h("main", { class: "container" }, h("p", {}, "Loading…"));
  mount(root, renderNav(), main);

  const result = await run(adminStats().pipe(withAuth, toEffect)).catch((error: unknown) => {
    console.error("admin stats request failed", error);
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
    Match.tag("ok", ({ body: stats }) => {
      const statusBox = h("p", { class: "hint hidden" });
      const reasonInput = h("textarea", { name: "reason", rows: "2" });

      const showStatus = (message: string): void => {
        statusBox.textContent = message;
        statusBox.classList.remove("hidden");
      };

      const refreshForm = h(
        "form",
        {
          class: "card form",
          onsubmit: (event: Event) => {
            event.preventDefault();
            statusBox.classList.add("hidden");
            const reason = reasonInput.value.trim();

            void run(withAuth(adminRefreshCache()).setBody(reason ? { reason } : {}).pipe(toEffect))
              .then((refreshResult) => {
                const message = domainErrorMessage(refreshResult);
                if (message) {
                  showStatus(message);
                  return;
                }
                Match.value(refreshResult).pipe(
                  Match.tag("reset", () => {
                    // 205 Reset Content: the server is telling us to reset the view that
                    // submitted the request, so the reason field clears itself right here.
                    reasonInput.value = "";
                    showStatus("Cache refreshed (205 Reset Content) — the reason field above was cleared.");
                  }),
                  Match.orElse(() => showStatus("Unexpected response from the server.")),
                );
              })
              .catch((error: unknown) => {
                console.error("cache refresh failed", error);
                showStatus("Could not reach the server. Is it running?");
              });
          },
        },
        h("h2", {}, "Refresh cache"),
        statusBox,
        h("label", {}, "Reason (optional)", reasonInput),
        h("button", { type: "submit" }, "Refresh"),
      );

      mount(
        main,
        h("h1", {}, "Admin"),
        h(
          "dl",
          { class: "stats" },
          h("dt", {}, "Users"),
          h("dd", {}, String(stats.users)),
          h("dt", {}, "Posts"),
          h("dd", {}, String(stats.posts)),
          h("dt", {}, "Comments"),
          h("dd", {}, String(stats.comments)),
          h("dt", {}, "Stats generated at"),
          h("dd", {}, new Date(DateTime.toEpochMillis(stats.generatedAt)).toLocaleString()),
        ),
        refreshForm,
        renderUsersDirectory(),
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
