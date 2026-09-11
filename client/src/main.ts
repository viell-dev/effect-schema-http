import { h, mount } from "./dom.js";
import { getSession, onSessionChange } from "./session.js";
import { renderAuthView } from "./ui/authView.js";
import { renderFilesView } from "./ui/filesView.js";
import { renderProjectsView } from "./ui/projectsView.js";
import { renderQuirksView } from "./ui/quirksView.js";
import { renderSearchView } from "./ui/searchView.js";

type Tab = "auth" | "projects" | "search" | "files" | "quirks";

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
      h("h1", {}, "Multi-Service Integration Client"),
      h(
        "p",
        {},
        session
          ? `Signed in as ${session.username || "User"} (${session.accessToken.slice(0, 15)}...)`
          : "Not signed in — go to Auth tab to register or login",
      ),
    ),
    h(
      "div",
      { class: "service-badges" },
      h("span", { class: "badge badge-rust" }, "Rust ID (4100)"),
      h("span", { class: "badge badge-python" }, "Python File (4200)"),
      h("span", { class: "badge badge-java" }, "Java API (4300)"),
      h("span", { class: "badge badge-ts" }, "TS Client"),
    ),
  );

  // Tabs
  const tabDefs: Array<{ id: Tab; label: string }> = [
    { id: "auth", label: "🔐 Identity & Auth" },
    { id: "projects", label: "📋 Projects & Tasks" },
    { id: "search", label: "🔍 Search" },
    { id: "files", label: "📁 SOAP Files" },
    { id: "quirks", label: "⚠️ Quirks Verification" },
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
    case "quirks":
      content = renderQuirksView();
      break;
  }

  const main = h("main", {}, content);

  mount(app, header, nav, main);
};

onSessionChange(() => {
  renderApp();
});

renderApp();
