import { toEffect } from "viell-effect-schema-http";
import { append, h } from "../dom.js";
import { run } from "../runtime.js";
import { search } from "../services/apiClient.js";

export const renderSearchView = (): HTMLElement => {
  const logBox = h("div", { class: "log-box" }, "Ready for search...");

  const appendLog = (msg: string) => {
    logBox.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n\n${logBox.textContent}`;
  };

  const searchInput = h("input", { type: "text", placeholder: "Search query (e.g. 'Project', 'Task', 'Alpha')", value: "Project" });
  const resultsContainer = h("div", {}, "Enter a query to search across projects and tasks.");

  const executeSearch = async () => {
    const q = searchInput.value.trim();
    if (!q) return;

    try {
      resultsContainer.textContent = "Searching...";
      appendLog(`Dispatching search query: "${q}"...`);

      const res = await run(search(q).pipe(toEffect));
      const hits = res.body;

      appendLog(`✓ Search succeeded! Returned ${hits.length} normalized hits.`);
      appendLog(`⚠️ QUIRK OBSERVED: If the server matched exactly 1 item, the wire JSON was a bare object, NOT an array. Our Effect Schema transform normalized it into an array seamlessly.`);

      resultsContainer.replaceChildren();
      if (hits.length === 0) {
        resultsContainer.textContent = "No items matched the query.";
        return;
      }

      for (const hit of hits) {
        const isProject = hit.type === "project";
        const card = h(
          "div",
          { class: "item-card" },
          h(
            "div",
            { class: "item-header" },
            h("strong", {}, isProject ? hit.name : hit.title),
            h("span", { class: `badge ${isProject ? "badge-python" : "badge-rust"}` }, hit.type.toUpperCase()),
          ),
          h("p", { style: "margin: 0.25rem 0;" }, hit.description),
          h("div", { class: "item-meta" }, `ID: ${hit.id} | Updated: ${hit.updatedAt.toLocaleString()}`),
        );
        resultsContainer.appendChild(card);
      }
    } catch (err) {
      resultsContainer.textContent = `Search failed: ${String(err)}`;
      appendLog(`✗ Search error: ${String(err)}`);
    }
  };

  const searchBtn = h("button", { class: "btn btn-primary" }, "Search");
  searchBtn.onclick = () => void executeSearch();

  searchInput.onkeydown = (e) => {
    if (e.key === "Enter") void executeSearch();
  };

  return h(
    "div",
    {},
    h(
      "div",
      { class: "quirk-callout" },
      h("strong", {}, "Historical Quirks on Search Endpoint:"),
      h("br"),
      "1. Jackson 'WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED': When exactly 1 result matches, the server returns an unwrapped object, NOT an array.",
      h("br"),
      "2. When multiple results match, it returns an array of objects.",
      h("br"),
      "3. Effect Schema's SearchResults transform handles both shapes automatically so the UI only ever sees an array.",
    ),
    h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Multi-Service Search"),
      h("div", { style: "display: flex; gap: 0.5rem; margin-bottom: 1rem;" }, searchInput, searchBtn),
      resultsContainer,
    ),
    h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Activity Log"), logBox),
  );
};
