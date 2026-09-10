import { Match } from "effect";
import { LoginInput } from "@realworld/domain";
import { toEffect } from "viell-effect-schema-http";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { login } from "../api.js";
import { run } from "../runtime.js";
import { decodeForm } from "../decodeForm.js";
import { domainErrorMessage } from "../errors.js";
import { establishSession } from "../establishSession.js";
import { navigate } from "../router.js";

export const renderLoginPage = (root: HTMLElement): void => {
  const errorBox = h("p", { class: "error hidden" });
  const emailInput = h("input", { type: "email", name: "email", required: "true", autocomplete: "email" });
  const passwordInput = h("input", {
    type: "password",
    name: "password",
    required: "true",
    autocomplete: "current-password",
  });

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

        const decoded = decodeForm(LoginInput, {
          email: emailInput.value,
          password: passwordInput.value,
        });
        if (decoded._tag === "failure") {
          showError(decoded.issues.join("; "));
          return;
        }

        void run(login().setBody(decoded.value).pipe(toEffect))
          .then((result) => {
            const domainMessage = domainErrorMessage(result);
            if (domainMessage) {
              showError(domainMessage);
              return;
            }
            Match.value(result).pipe(
              Match.tag("ok", ({ body }) => {
                void establishSession(body).then(() => navigate("/"));
              }),
              Match.orElse(() => showError("Unexpected response from the server.")),
            );
          })
          .catch((error: unknown) => {
            console.error("login failed", error);
            showError("Could not reach the server. Is it running?");
          });
      },
    },
    h("h1", {}, "Sign in"),
    errorBox,
    h("label", {}, "Email", emailInput),
    h("label", {}, "Password", passwordInput),
    h("button", { type: "submit" }, "Sign in"),
    h("p", {}, "No account? ", h("a", { href: "#/register" }, "Sign up")),
  );

  mount(root, renderNav(), h("main", { class: "container container-narrow" }, form));
};
