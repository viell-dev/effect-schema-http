import { Effect, Exit, Scope } from "effect";
import { Request } from "viell-effect-schema-http";
import { h, onUnmount } from "../dom.js";
import { makeReconciliationGate, type ReconciliationView } from "../integration/gates.js";
import { runReconciliation } from "../integration/saga.js";
import { defaultRuntime, run, runFork } from "../runtime.js";
import { createProject } from "../services/apiClient.js";
import { reportLogin } from "../services/reportClient.js";
import { getReportSession, setReportSession } from "../session.js";
import { actionPanel, describeFailure, field, type Action } from "./panel.js";

/**
 * The reconciliation screen: a filter-as-you-type box over two services at once, and the
 * five-service saga underneath it.
 *
 * The filter box is the library's own motivating example for `Interaction.make`, built
 * against a client that has to ask two backends and translate one into the other before
 * it can render a row.
 */
export const renderSearchView = (): HTMLElement => {
  const term = h("input", {
    type: "text",
    placeholder: "filter the live system and the nightly extract…",
  }) as HTMLInputElement;
  const status = h("p", { class: "blurb" }, "Type to search. Every keystroke cancels the previous flight.");
  const results = h("pre", { class: "output" }, "Ready.");

  const scope = Effect.runSync(Scope.make());
  const gate = defaultRuntime.runSync(makeReconciliationGate().pipe(Scope.extend(scope)));
  let sequence = 0;

  const render = (view: ReconciliationView) => {
    results.textContent = [
      `term: ${view.term}`,
      `live matches on the Java service: ${view.liveMatches}`,
      "",
      "drafts translated from the 1999 nightly extract:",
      ...(view.drafts.length === 0
        ? ["  (none)"]
        : view.drafts.map(
            (draft) => `  ${draft.status.padEnd(12)} p${draft.priority}  ${draft.title}\n    ${draft.description}`,
          )),
    ].join("\n");
  };

  term.oninput = () => {
    const value = term.value;
    const current = ++sequence;
    status.textContent = value.trim() === "" ? "Ready." : `searching for “${value}”…`;
    runFork(
      gate.run(value).pipe(
        Effect.tap((view) =>
          Effect.sync(() => {
            if (current !== sequence) return;
            status.textContent = `showing “${view.term}”`;
            render(view);
          }),
        ),
      ),
    );
  };

  const actions: ReadonlyArray<Action> = [
    {
      label: "Sign in to the gateway",
      note: "The reporting gateway has its own session and has never heard of the identity server.",
      run: async () => {
        const result = await run(
          reportLogin({
            request: (request) =>
              request.pipe(Request.setQuery("user", "reconciler"), Request.setQuery("pass", "hunter2")),
          }).execute(undefined),
        );
        if (result._tag !== "ok" || result.value._tag !== "session") return "the gateway refused";
        setReportSession(result.value.session);
        return `gateway session ${result.value.session}`;
      },
    },
    {
      label: "Run the month-end reconciliation",
      note: "Five services, five languages: Perl in, Java out, Python for the bytes, Ruby to announce it.",
      run: async () => {
        if (getReportSession() === undefined) return "sign in to the gateway first";
        const owner = `saga_${Date.now().toString(36)}`;
        const project = await run(
          createProject().execute({ body: { name: `Reconciliation ${owner}`, description: "" } }),
        );
        if (project._tag !== "created") return "could not create the project to reconcile into";

        try {
          const report = await run(runReconciliation(owner, "saga_password_123", project.value.id));
          return [
            `1. Rust    signed in as ${report.username}`,
            `2. Perl    read ${report.extractedRecords} records, control total ${(report.controlTotal / 100).toFixed(2)}`,
            `3.         translated each one into a task the Java server accepts`,
            `4. Java    created ${report.createdTaskIds.length} tasks`,
            `5. Python  stored the re-encoded extract as ${report.soapFileId}`,
            `6. Java    proxied the same bytes as SOAP: ${report.proxyStatus}`,
            `7. Ruby    announced it, signed: "${report.notificationText}"`,
            `8. Java    search finds ${report.foundInSearch} match(es)`,
          ].join("\n");
        } catch (error) {
          return `the saga failed and rolled the tasks back:\n${describeFailure(error)}`;
        }
      },
    },
  ];

  const view = h(
    "div",
    {},
    h("div", { class: "fields" }, field("").row),
    h("section", { class: "panel" }, h("h2", {}, "Filter as you type, across two services"), status, term, results),
    actionPanel(
      "The month-end reconciliation",
      "Reading a value from one service, translating it into another service's own schema, writing it, and announcing it to a third — with a compensation, because no transaction spans five processes.",
      actions,
    ),
  );
  onUnmount(view, () => {
    ++sequence;
    void run(Scope.close(scope, Exit.void));
  });
  return view;
};
