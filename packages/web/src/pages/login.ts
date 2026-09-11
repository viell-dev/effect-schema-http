import { Match } from "effect";
import { LegacyLoginForm, LoginInput } from "@realworld/domain";
import { toEffect } from "viell-effect-schema-http";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { legacyLogin, login } from "../api.js";
import { run } from "../runtime.js";
import { decodeForm } from "../decodeForm.js";
import { domainErrorMessage } from "../errors.js";
import { establishSession } from "../establishSession.js";
import { navigate } from "../router.js";

export const renderLoginPage = (root: HTMLElement): void => {
  const errorBox = h("p", { class: "error hidden" });
  // The original mobile client posted a form, not JSON, and that endpoint is still answered. This
  // toggle sends the same credentials through it — same brands, same validation, same response
  // schema; only the request codec differs (`RequestBody.urlParams` instead of the JSON default).
  const legacyToggle = h("input", { type: "checkbox", name: "legacy" });
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

        // Two endpoints, two request codecs, one response shape — so everything after this point
        // is identical for both. Each branch decodes against the schema *its* endpoint declares,
        // which is what lets `.setBody` accept the result without a cast, and each branch extracts
        // its own Effect: the two plan *types* differ (different body schemas), but the Effects
        // they produce are the same type, because the two endpoints declare the same responses.
        const prepared = legacyToggle.checked
          ? (() => {
              const decoded = decodeForm(LegacyLoginForm, {
                email: emailInput.value,
                password: passwordInput.value,
                grant_type: "password",
              });
              return decoded._tag === "failure" ? decoded : legacyLogin().setBody(decoded.value).pipe(toEffect);
            })()
          : (() => {
              const decoded = decodeForm(LoginInput, {
                email: emailInput.value,
                password: passwordInput.value,
              });
              return decoded._tag === "failure" ? decoded : login().setBody(decoded.value).pipe(toEffect);
            })();

        if ("_tag" in prepared) {
          showError(prepared.issues.join("; "));
          return;
        }

        void run(prepared)
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
    h("label", { class: "checkbox" }, legacyToggle, " Sign in through the legacy form endpoint"),
    h("button", { type: "submit" }, "Sign in"),
    h("p", {}, "No account? ", h("a", { href: "#/register" }, "Sign up")),
  );

  mount(root, renderNav(), h("main", { class: "container container-narrow" }, form));
};
