/**
 * Filter-as-you-type user directory, driven by `usersGate.ts`. Every `input` event is a genuinely
 * distinct request (a different filter string), so this is the shape that needs the gate's
 * interruption behavior rather than its cross-call cache-hit behavior — see that module's TSDoc.
 */
import { Effect, Match } from "effect";
import { h } from "../dom.js";
import { domainErrorMessage } from "../errors.js";
import { run } from "../runtime.js";
import { getUsersGate, type UserFilters } from "../usersGate.js";

export const renderUsersDirectory = (): HTMLElement => {
  const nameInput = h("input", { type: "text", name: "name", placeholder: "Filter by name" });
  const emailInput = h("input", { type: "text", name: "email", placeholder: "Filter by email" });
  const statusLine = h("p", { class: "hint hidden" });
  const tableBody = h("tbody");

  let requestSeq = 0;

  const currentFilters = (): UserFilters => ({ name: nameInput.value, email: emailInput.value });

  const renderRows = (users: ReadonlyArray<{ username: string; displayName: string; email: string; role: string }>) => {
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

  const runFilter = async (): Promise<void> => {
    const filters = currentFilters();
    const mySeq = ++requestSeq;
    const gate = await getUsersGate();

    // Interrupt whatever the previous keystroke's request is still doing before starting this
    // one — see usersGate.ts for why `invalidate` (not plain `run`) is the tool for that.
    await Effect.runPromise(gate.invalidate);
    if (mySeq !== requestSeq) return;

    statusLine.textContent = "Loading…";
    statusLine.classList.remove("hidden");

    const result = await run(gate.run(filters)).catch((error: unknown) => {
      // A superseded request rejects because its fiber was interrupted by the *next*
      // keystroke's `invalidate` — that is expected and not a real failure to report.
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

  nameInput.addEventListener("input", () => void runFilter());
  emailInput.addEventListener("input", () => void runFilter());
  void runFilter();

  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Users"),
    h(
      "div",
      { class: "filter-row" },
      h("label", {}, "Name", nameInput),
      h("label", {}, "Email", emailInput),
    ),
    statusLine,
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Username"), h("th", {}, "Display name"), h("th", {}, "Email"), h("th", {}, "Role"))),
      tableBody,
    ),
  );
};
