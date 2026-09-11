import { DateTime, Effect, Match } from "effect";
import { toEffect, UnhandledResponse } from "viell-effect-schema-http";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderUsersDirectory } from "../components/usersDirectory.js";
import { adminDiagnostics, adminRefreshCache, adminReindex, adminStats } from "../api.js";
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

      /**
       * The retry path. The endpoint declares `retry: { times: 3 }` (see `api.ts`), the server
       * answers `503` with a `Retry-After` until its warm-standby search cluster is up, and the
       * library rides through that without this handler seeing the intermediate failures at all:
       * `503` is already in its transient classification, so what arrives here is the `202` — with
       * an `attempts` count from the server proving how many requests it actually took.
       *
       * `warmingUp` is still declared as a response rule, because retries are finite: if the
       * cluster never comes up, the last `503` is a perfectly ordinary mapped success value rather
       * than an `UnhandledResponse`.
       */
      const reindexStatus = h("p", { class: "hint hidden" });
      const reindexButton = h(
        "button",
        {
          type: "button",
          onclick: () => {
            reindexStatus.classList.remove("hidden");
            reindexStatus.textContent = "Reindexing (the cluster may need a few attempts)…";
            void run(adminReindex().pipe(withAuth, toEffect))
              .then((reindexResult) => {
                const message = domainErrorMessage(reindexResult);
                if (message) {
                  reindexStatus.textContent = message;
                  return;
                }
                Match.value(reindexResult).pipe(
                  Match.tag("accepted", ({ body }) => {
                    reindexStatus.textContent = `Indexed ${body.indexed} posts after ${body.attempts} server-side attempts.`;
                  }),
                  Match.tag("warmingUp", ({ body }) => {
                    reindexStatus.textContent = `Gave up while retrying: ${body.message}`;
                  }),
                  Match.orElse(() => {
                    reindexStatus.textContent = "Unexpected response from the server.";
                  }),
                );
              })
              .catch((error: unknown) => {
                console.error("reindex failed", error);
                reindexStatus.textContent = "Could not reach the server. Is it running?";
              });
          },
        },
        "Reindex search",
      );

      /**
       * The unmapped-response path. `adminDiagnostics` maps only the modern subsystem's JSON, and
       * declares `unhandledResponseBody: "retain"`, so when the old watchdog answers its
       * plain-text dump instead the library hands this caller the *live* response rather than
       * draining it. Ownership then belongs here: read the body, or run `error.discard`. Doing
       * neither would leak the transport resource, which is exactly why the library drains
       * unmapped bodies unless a caller opts out.
       */
      const degradedToggle = h("input", { type: "checkbox", name: "degraded" });
      const diagnosticsOutput = h("pre", { class: "export-output hidden" });
      const diagnosticsButton = h(
        "button",
        {
          type: "button",
          onclick: () => {
            diagnosticsOutput.classList.remove("hidden");
            diagnosticsOutput.textContent = "Collecting…";
            const plan = adminDiagnostics().setUrlParam("degraded", degradedToggle.checked ? "1" : "0");

            void run(
              plan.pipe(
                withAuth,
                toEffect,
                // An unmapped response is an ordinary Effect failure, so it is caught in the error
                // channel rather than by inspecting the success union.
                Effect.catchTag("UnhandledResponse", (unhandled: UnhandledResponse) =>
                  // Reading `.text` consumes the retained body; that *is* taking ownership of it.
                  unhandled.response.text.pipe(
                    Effect.map((raw) => `Unmapped ${unhandled.status} response, body retained:\n\n${raw}`),
                    // If even reading it fails, drain what is left so the transport is released.
                    Effect.catchAll(() =>
                      unhandled.discard.pipe(
                        Effect.orElse(() => Effect.void),
                        Effect.as(`Unmapped ${unhandled.status} response; its body could not be read and was discarded.`),
                      ),
                    ),
                  ),
                ),
              ),
            )
              .then((diagnosticsResult) => {
                if (typeof diagnosticsResult === "string") {
                  diagnosticsOutput.textContent = diagnosticsResult;
                  return;
                }
                const message = domainErrorMessage(diagnosticsResult);
                if (message) {
                  diagnosticsOutput.textContent = message;
                  return;
                }
                Match.value(diagnosticsResult).pipe(
                  Match.tag("ok", ({ body }) => {
                    diagnosticsOutput.textContent = `${body.subsystem} subsystem: ${
                      body.healthy ? "healthy" : "unhealthy"
                    } (checked ${new Date(DateTime.toEpochMillis(body.checkedAt)).toLocaleString()})`;
                  }),
                  Match.orElse(() => {
                    diagnosticsOutput.textContent = "Unexpected response from the server.";
                  }),
                );
              })
              .catch((error: unknown) => {
                console.error("diagnostics failed", error);
                diagnosticsOutput.textContent = "Could not reach the server. Is it running?";
              });
          },
        },
        "Collect diagnostics",
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
        h(
          "section",
          { class: "card form" },
          h("h2", {}, "Search index"),
          reindexStatus,
          reindexButton,
        ),
        h(
          "section",
          { class: "card form" },
          h("h2", {}, "Diagnostics"),
          h("label", { class: "checkbox" }, degradedToggle, " Simulate an unhealthy modern subsystem"),
          diagnosticsButton,
          diagnosticsOutput,
        ),
        renderUsersDirectory(),
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
