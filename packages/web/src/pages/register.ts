import { Match } from "effect";
import { RegisterInput } from "@realworld/domain";
import { toEffect } from "viell-effect-schema-http";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { register } from "../api.js";
import { run } from "../runtime.js";
import { decodeForm } from "../decodeForm.js";
import { domainErrorMessage } from "../errors.js";
import { establishSession } from "../establishSession.js";
import { navigate } from "../router.js";

export const renderRegisterPage = (root: HTMLElement): void => {
  const errorBox = h("p", { class: "error hidden" });
  const usernameInput = h("input", { type: "text", name: "username", required: "true", autocomplete: "username" });
  const displayNameInput = h("input", { type: "text", name: "displayName", required: "true" });
  const emailInput = h("input", { type: "email", name: "email", required: "true", autocomplete: "email" });
  const passwordInput = h("input", {
    type: "password",
    name: "password",
    required: "true",
    autocomplete: "new-password",
  });
  const bioInput = h("textarea", { name: "bio", rows: "3" });

  const showError = (message: string): void => {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  };

  const form = h(
    "form",
    {
      class: "card form",
      onsubmit: (event: Event) => {
        event.preventDefault();
        errorBox.classList.add("hidden");

        const decoded = decodeForm(RegisterInput, {
          username: usernameInput.value,
          displayName: displayNameInput.value,
          email: emailInput.value,
          password: passwordInput.value,
          bio: bioInput.value === "" ? undefined : bioInput.value,
        });
        if (decoded._tag === "failure") {
          showError(decoded.issues.join("; "));
          return;
        }

        void run(register().setBody(decoded.value).pipe(toEffect))
          .then((result) => {
            const domainMessage = domainErrorMessage(result);
            if (domainMessage) {
              showError(domainMessage);
              return;
            }
            Match.value(result).pipe(
              Match.tag("created", ({ body }) => {
                void establishSession(body).then(() => navigate("/"));
              }),
              Match.orElse(() => showError("Unexpected response from the server.")),
            );
          })
          .catch((error: unknown) => {
            console.error("registration failed", error);
            showError("Could not reach the server. Is it running?");
          });
      },
    },
    h("h1", {}, "Sign up"),
    errorBox,
    h("label", {}, "Username", usernameInput),
    h("label", {}, "Display name", displayNameInput),
    h("label", {}, "Email", emailInput),
    h("label", {}, "Password", passwordInput),
    h("label", {}, "Bio (optional)", bioInput),
    h("button", { type: "submit" }, "Sign up"),
    h("p", {}, "Already have an account? ", h("a", { href: "#/login" }, "Sign in")),
  );

  mount(root, renderNav(), h("main", { class: "container container-narrow" }, form));
};
