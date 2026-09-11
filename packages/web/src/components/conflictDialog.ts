/**
 * The dialog a `409` opens: "someone else changed this, what do you want to do?".
 *
 * Worth noting what makes this straightforward with this library: a `409` is not an exception
 * here. The API declares `ConflictError` as an ordinary response rule, so a conflict arrives as a
 * normal, decoded, typed success value carrying the server's message — which is exactly what this
 * dialog needs to display. There is no catch block, no status-code check, and no second parse.
 */
import { h } from "../dom.js";

export interface ConflictChoice {
  readonly force: boolean;
}

export const askAboutConflict = (message: string): Promise<ConflictChoice> =>
  new Promise((resolve) => {
    const close = (force: boolean) => {
      backdrop.remove();
      resolve({ force });
    };

    const backdrop = h(
      "div",
      {
        class: "modal-backdrop",
        onclick: (event: Event) => {
          if (event.target === backdrop) close(false);
        },
      },
      h(
        "div",
        { class: "modal card", role: "alertdialog" },
        h("h2", {}, "Another user has updated this post"),
        h("p", {}, message),
        h(
          "p",
          { class: "hint" },
          "Closing keeps their version. Forcing the update replaces it with what you have on screen.",
        ),
        h(
          "div",
          { class: "modal-actions" },
          h("button", { type: "button", class: "secondary", onclick: () => close(false) }, "Close"),
          h("button", { type: "button", onclick: () => close(true) }, "Force update"),
        ),
      ),
    );

    document.body.append(backdrop);
  });
