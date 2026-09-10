import { h } from "../dom.js";
import { clearSession, getSession } from "../session.js";
import { navigate } from "../router.js";

export const renderNav = (): HTMLElement => {
  const session = getSession();
  return h(
    "nav",
    { class: "nav" },
    h("a", { class: "brand", href: "#/" }, "realworld-schema-http"),
    h(
      "div",
      { class: "nav-links" },
      h("a", { href: "#/" }, "Feed"),
      session
        ? h(
            "span",
            { class: "nav-session" },
            h("a", { href: `#/blog/${session.profile.username}` }, session.profile.username),
            h("a", { href: "#/new" }, "New post"),
            session.role === "admin" ? h("a", { href: "#/admin" }, "Admin") : null,
            h(
              "a",
              {
                href: "#/",
                onclick: (event: Event) => {
                  event.preventDefault();
                  clearSession();
                  navigate("/");
                },
              },
              "Sign out",
            ),
          )
        : h(
            "span",
            { class: "nav-session" },
            h("a", { href: "#/login" }, "Sign in"),
            h("a", { href: "#/register" }, "Sign up"),
          ),
    ),
  );
};
