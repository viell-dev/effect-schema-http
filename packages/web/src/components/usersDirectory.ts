/**
 * Filter-as-you-type user directory, driven by `usersGate.ts`. Every `input` event is a genuinely
 * distinct request (a different filter string), so this is the shape that needs the gate's
 * interruption behavior — but not at the price of its cross-call reuse. See that module's TSDoc.
 */
import { Effect, Match } from "effect";
import { h, onUnmount } from "../dom.js";
import { domainErrorMessage } from "../errors.js";
import { run } from "../runtime.js";
import { makeUsersGate, usersFilterKey, type UserFilters } from "../usersGate.js";

interface DirectoryUser {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
}

export const renderUsersDirectory = (): HTMLElement => {
  const nameInput = h("input", { type: "text", name: "name", placeholder: "Filter by name" });
  const emailInput = h("input", { type: "text", name: "email", placeholder: "Filter by email" });
  const refreshButton = h("button", { type: "button", class: "secondary" }, "Refresh");
  const statusLine = h("p", { class: "hint hidden" });
  const tableBody = h("tbody");

  const gate = Effect.runSync(makeUsersGate());
  let requestSeq = 0;
  // The filter whose rows the gate is currently retaining, tracked with the gate's own key
  // function so "will this `run` hit the cache?" is answered the same way the gate answers it.
  let retainedKey: string | undefined;

  const currentFilters = (): UserFilters => ({ name: nameInput.value, email: emailInput.value });

  const renderRows = (users: ReadonlyArray<DirectoryUser>) => {
    tableBody.replaceChildren(
      ...(users.length === 0
        ? [h("tr", {}, h("td", { colspan: "4", class: "empty" }, "No matching users."))]
        : users.map((user) =>
            h(
              "tr",
              {},
              h("td", {}, h("a", { href: `#/blog/${user.username}` }, user.username)),
              h("td", {}, user.displayName),
              h("td", {}, user.email),
              h("td", {}, user.role),
            ),
          )),
    );
  };

  /**
   * `mode: "run"` is the keystroke path: supersede the previous request, then reuse the gate's
   * retained success when this filter is one it already answered. `mode: "refresh"` is the
   * Refresh button: bypass both the cache and any equivalent flight and go to the server.
   */
  const load = async (mode: "run" | "refresh"): Promise<void> => {
    const filters = currentFilters();
    const mySeq = ++requestSeq;
    const key = usersFilterKey(filters);
    const servedFromCache = mode === "run" && key === retainedKey;

    if (!servedFromCache) {
      statusLine.textContent = "Loading…";
      statusLine.classList.remove("hidden");
    }

    const result = await run(gate.run(filters, { force: mode === "refresh" })).catch((error: unknown) => {
      // A superseded request rejects because its fiber was interrupted by the *next*
      // keystroke's `run` — that is expected and not a real failure to report.
      if (mySeq !== requestSeq) return undefined;
      console.error("user directory request failed", error);
      return undefined;
    });
    if (mySeq !== requestSeq || !result) {
      if (mySeq === requestSeq && !result) {
        statusLine.textContent = "Could not reach the server. Is it running?";
      }
      return;
    }

    // Every mapped response — including the shared domain errors — is a gate success, so this is
    // exactly what the gate is now retaining under this key.
    retainedKey = key;

    const errorMessage = domainErrorMessage(result);
    if (errorMessage) {
      statusLine.textContent = errorMessage;
      return;
    }

    Match.value(result).pipe(
      Match.tag("ok", ({ body }) => {
        statusLine.classList.add("hidden");
        renderRows(body.users);
      }),
      Match.orElse(() => {
        statusLine.textContent = "Unexpected response from the server.";
      }),
    );
  };

  nameInput.addEventListener("input", () => void load("run"));
  emailInput.addEventListener("input", () => void load("run"));
  refreshButton.addEventListener("click", () => void load("refresh"));
  void load("run");

  const view = h(
    "section",
    { class: "card" },
    h("h2", {}, "Users"),
    h(
      "div",
      { class: "filter-row" },
      h("label", {}, "Name", nameInput),
      h("label", {}, "Email", emailInput),
      refreshButton,
    ),
    statusLine,
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h("tr", {}, h("th", {}, "Username"), h("th", {}, "Display name"), h("th", {}, "Email"), h("th", {}, "Role")),
      ),
      tableBody,
    ),
  );
  onUnmount(view, () => {
    ++requestSeq;
    void run(gate.dispose);
  });
  return view;
};
