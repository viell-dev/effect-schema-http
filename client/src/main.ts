import { h, mount } from "./dom.js";
import { getSession, onSessionChange } from "./session.js";
import { renderAuthView } from "./ui/authView.js";
import { renderFilesView } from "./ui/filesView.js";
import { renderProjectsView } from "./ui/projectsView.js";
import { renderNotifyView } from "./ui/notifyView.js";
import { renderQuirksView } from "./ui/quirksView.js";
import { renderReportsView } from "./ui/reportsView.js";
import { renderSearchView } from "./ui/searchView.js";

type Tab = "auth" | "projects" | "files" | "reports" | "notify" | "search" | "quirks";

const app = document.getElementById("app");
if (!app) throw new Error("Root element #app not found");

let currentTab: Tab = "auth";

const renderApp = () => {
  const session = getSession();

  // Header
  const header = h(
    "header",
    {},
    h(
      "div",
      { class: "header-title" },
      h("h1", {}, "Five services, five languages, one client"),
      h(
        "p",
        {},
        session === undefined
          ? "Not signed in. Each service has its own idea of a credential; start with Identity."
          : `Signed in as ${session.username ?? "someone"} (${session.accessToken.slice(0, 12)}…)`,
      ),
    ),
    h(
      "div",
      { class: "service-badges" },
      h("span", { class: "badge badge-rust" }, "Rust · 4100"),
      h("span", { class: "badge badge-python" }, "Python · 4200"),
      h("span", { class: "badge badge-java" }, "Java · 4300"),
      h("span", { class: "badge badge-perl" }, "Perl · 4400"),
      h("span", { class: "badge badge-ruby" }, "Ruby · 4500"),
    ),
  );

  // Tabs
  const tabDefs: Array<{ id: Tab; label: string }> = [
    { id: "auth", label: "Identity (Rust)" },
    { id: "projects", label: "Business API (Java)" },
    { id: "files", label: "Files (Python)" },
    { id: "reports", label: "Reports (Perl)" },
    { id: "notify", label: "Notifications (Ruby)" },
    { id: "search", label: "Reconciliation" },
    { id: "quirks", label: "The inventory" },
  ];

  const tabButtons = tabDefs.map(({ id, label }) =>
    h(
      "button",
      {
        class: currentTab === id ? "active" : "",
        onclick: () => {
          currentTab = id;
          renderApp();
        },
      },
      label,
    ),
  );

  const nav = h("nav", { class: "tabs" }, ...tabButtons);

  // Content
  let content: HTMLElement;
  switch (currentTab) {
    case "auth":
      content = renderAuthView();
      break;
    case "projects":
      content = renderProjectsView();
      break;
    case "search":
      content = renderSearchView();
      break;
    case "files":
      content = renderFilesView();
      break;
    case "reports":
      content = renderReportsView();
      break;
    case "notify":
      content = renderNotifyView();
      break;
    case "quirks":
      content = renderQuirksView();
      break;
  }

  const main = h("main", {}, content);

  mount(app, header, nav, main);
};

// A credential update must not unmount the action (or interaction scope) that produced it.
onSessionChange((session) => {
  const summary = app.querySelector(".header-title p");
  if (summary)
    summary.textContent =
      session === undefined
        ? "Not signed in. Each service has its own idea of a credential; start with Identity."
        : `Signed in as ${session.username ?? "someone"} (${session.accessToken.slice(0, 12)}…)`;
});

renderApp();
