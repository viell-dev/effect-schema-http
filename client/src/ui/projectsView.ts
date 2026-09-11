import { DateTime, Effect } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h } from "../dom.js";
import { tunnelMethod } from "../plans/transforms.js";
import { run } from "../runtime.js";
import {
  createProject,
  createTask,
  deleteTask,
  listProjects,
  listTasks,
  patchProject,
  search,
} from "../services/apiClient.js";
import {
  batchGet,
  getVersionedProject,
  gridReport,
  importStatus,
  listOrders,
  listProjectsPage,
  lookup,
  putVersionedProject,
  startImport,
} from "../services/apiLegacyClient.js";
import { actionPanel, field, show, type Action } from "./panel.js";

/** Every call in this view goes to the Java business API on :4300. */
export const renderProjectsView = (): HTMLElement => {
  const projectName = field("project name", `Web project ${new Date().toISOString().slice(11, 19)}`);
  const projectId = field("project id", "");
  const taskTitle = field("task title", "Reconcile the extract");

  const actions: ReadonlyArray<Action> = [
    {
      label: "Create a project",
      note: "Authorization: Token, not Bearer. This API predates RFC 6750 and never migrated.",
      run: async () => {
        const result = await run(
          createProject().setBody({ name: projectName.input.value, description: "created from the web client" }).pipe(toEffect),
        );
        if (result._tag !== "created") return `${result._tag}: ${show(result.body)}`;
        projectId.input.value = result.body.id;
        return `created ${result.body.id}\ncreatedAt arrived as epoch milliseconds and decoded to ${DateTime.formatIso(result.body.createdAt)}`;
      },
    },
    {
      label: "Rename it (PATCH)",
      note: "PATCH answers with the state the resource had before the write. Deliberately.",
      run: async () => {
        const renamed = `${projectName.input.value} (renamed)`;
        const patched = await run(patchProject({ id: projectId.input.value }).setBody({ name: renamed }).pipe(toEffect));
        if (patched._tag !== "ok") return `${patched._tag}: ${show(patched.body)}`;
        const listed = await run(listProjects().pipe(toEffect));
        const current = listed._tag === "ok" ? listed.body.find((item) => item.id === projectId.input.value) : undefined;
        return `PATCH returned "${patched.body.name}"\nthe stored value is "${current?.name ?? "unknown"}"\n\nA developer read "return the resource" as "return what it was", and the mobile app now depends on it.`;
      },
    },
    {
      label: "Add a task",
      note: "The request sends a status name; the response answers with its ordinal.",
      run: async () => {
        const result = await run(
          createTask()
            .setBody({ projectId: projectId.input.value, title: taskTitle.input.value, status: "IN_PROGRESS", priority: 3 })
            .pipe(toEffect),
        );
        if (result._tag !== "created") return `${result._tag}: ${show(result.body)}`;
        return `created ${result.body.id}\nsent "IN_PROGRESS", received 1, decoded back to "${result.body.status}"`;
      },
    },
    {
      label: "List its tasks",
      note: "Plain JSON in and out — the case the library needs no configuration for at all.",
      run: async () => {
        const result = await run(listTasks(projectId.input.value).pipe(toEffect));
        return result._tag === "ok"
          ? result.body.map((task) => `${task.id}  ${task.status.padEnd(12)} ${task.title}`).join("\n") || "no tasks"
          : show(result.body);
      },
    },
    {
      label: "Delete a task (blocked, then tunnelled)",
      note: "The gateway strips DELETE. The same plan works with X-HTTP-Method-Override.",
      run: async () => {
        const tasks = await run(listTasks(projectId.input.value).pipe(toEffect));
        const target = tasks._tag === "ok" ? tasks.body[0] : undefined;
        if (target === undefined) return "no task to delete";
        const blocked = await run(deleteTask({ id: target.id }).pipe(toEffect));
        const tunnelled = await run(deleteTask({ id: target.id }).pipe(tunnelMethod("DELETE"), toEffect));
        return `raw DELETE:   ${blocked._tag} (${blocked.status})\ntunnelled:    ${tunnelled._tag} (${tunnelled.status})`;
      },
    },
    {
      label: "Conditional read and write",
      note: "The one endpoint here that is correct: a strong ETag, a real 304, and a 412.",
      run: async () => {
        const first = await run(getVersionedProject({ id: projectId.input.value }).pipe(toEffect));
        if (first._tag !== "ok") return `${first._tag}: ${show(first.body)}`;
        const etag = first.headers.etag ?? "";
        const repeated = await run(
          getVersionedProject({ id: projectId.input.value }).setHeader("if-none-match", etag).pipe(toEffect),
        );
        const stale = await run(
          putVersionedProject({ id: projectId.input.value })
            .setBody({ name: "should not apply" })
            .setHeader("if-match", '"stale"')
            .pipe(tunnelMethod("PUT"), toEffect),
        );
        const written = await run(
          putVersionedProject({ id: projectId.input.value })
            .setBody({ name: `${projectName.input.value} (conditional)` })
            .setHeader("if-match", etag)
            .pipe(tunnelMethod("PUT"), toEffect),
        );
        return [
          `read:            200 with ETag ${etag}`,
          `If-None-Match:   ${repeated._tag} (${repeated.status}), body ${String(repeated.body)}`,
          `stale If-Match:  ${stale._tag} (${stale.status})`,
          `fresh If-Match:  ${written._tag} (${written.status})`,
        ].join("\n");
      },
    },
    {
      label: "Read the orders (64-bit ids)",
      note: "Read as text and parsed with a different JSON dialect, because JSON.parse rounds them.",
      run: async () => {
        const result = await run(listOrders().pipe(toEffect));
        if (result._tag !== "ok") return show(result.body);
        const first = result.body.orders[0];
        if (first === undefined) return "no orders";
        return [
          `id kept exact:     ${first.id}`,
          `JSON.parse gives:  ${String(Number(first.id))}`,
          `amount:            ${first.amount} cents, from "${"$" + (first.amount / 100).toLocaleString("en-US")}"`,
          `orderDate:         ${DateTime.formatIso(first.orderDate)} from an ASP.NET /Date()/`,
          `cancelledOn:       ${first.cancelledOn === null ? "null, from the MySQL zero date" : DateTime.formatIso(first.cancelledOn)}`,
          `creditLimit:       ${show(first.creditLimit)}`,
          `customerRef:       ${show(first.customerRef)}`,
          `total:             ${result.body.total} (arrived as the string "__count" inside a "d" envelope)`,
        ].join("\n");
      },
    },
    {
      label: "Read the report grid",
      note: "Positional rows behind an unregistered text/json content type, checked against their header.",
      run: async () => {
        const result = await run(gridReport().pipe(toEffect));
        if (result._tag !== "ok") return show(result.body);
        return (
          result.body.rows
            .slice(0, 12)
            .map((row) => `${row.id}  ${row.status.padEnd(12)} p${row.priority}  ${row.title}`)
            .join("\n") || "no rows"
        );
      },
    },
    {
      label: "Batch three reads",
      note: "One 200 carrying three outcomes, discriminated in the schema because the envelope cannot.",
      run: async () => {
        const result = await run(
          batchGet()
            .setBody({
              requests: [
                { id: "mine", path: `/api/projects/${projectId.input.value}` },
                { id: "gone", path: "/api/projects/does-not-exist" },
                { id: "odd", path: "/api/unsupported" },
              ],
            })
            .pipe(toEffect),
        );
        if (result._tag !== "ok") return show(result.body);
        return result.body.responses
          .map((item) =>
            item._tag === "found" ? `${item.id}: found ${item.project.name}` : `${item.id}: ${item.status} ${item.code}`,
          )
          .join("\n");
      },
    },
    {
      label: "Start an import and follow it",
      note: "202 with a relative Location, then a poll that is a loop over a cold plan, not a retry.",
      run: async () => {
        const accepted = await run(startImport().setBody({ source: "web.csv" }).pipe(toEffect));
        if (accepted._tag !== "accepted") return show(accepted.body);
        const resolved = new URL(accepted.headers.location ?? "", "http://localhost:4300");
        const trail = [`202 Location: ${accepted.headers.location} -> ${resolved.href}`];
        const poll = Effect.promise(() => run(importStatus({ id: accepted.body.id }).pipe(toEffect)));
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const status = await Effect.runPromise(poll);
          if (status._tag !== "ok") return `${trail.join("\n")}\n${show(status.body)}`;
          trail.push(`poll ${attempt + 1}: ${status.body.state} ${status.body.progress}%`);
          if (status.body.state === "done") break;
        }
        return trail.join("\n");
      },
    },
    {
      label: "Look something up (errors in a header)",
      note: "Two rules at 200 separated only by X-Error-Code; the header-bearing one ranks first.",
      run: async () => {
        const good = await run(lookup().setUrlParam("q", projectName.input.value).pipe(toEffect));
        const bad = await run(lookup().setUrlParam("q", 'name:"unbalanced').pipe(toEffect));
        return [
          `plain query:  ${good._tag} (${good.status})`,
          good._tag === "ok" ? `  ${good.body.matches.length} match(es)` : "",
          `bad syntax:   ${bad._tag} (${bad.status})`,
          bad._tag === "LookupSyntaxError" ? `  ${bad.body.message}` : "",
        ]
          .filter((line) => line !== "")
          .join("\n");
      },
    },
    {
      label: "Page through projects",
      note: "The query parameter is 1-based; the Link header is 0-based. Both are the contract.",
      run: async () => {
        const first = await run(listProjectsPage().setUrlParam("page", "1").setUrlParam("pageSize", "2").pipe(toEffect));
        if (first._tag !== "ok") return show(first.body);
        return [
          `X-Total-Count: ${first.headers["x-total-count"]}`,
          `Link: ${first.headers.link}`,
          "",
          ...first.body.map((project) => `${project.id}  ${project.name}`),
        ].join("\n");
      },
    },
    {
      label: "Search (one hit is not an array)",
      note: "Jackson's WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED, normalized by a union in the schema.",
      run: async () => {
        const result = await run(search(taskTitle.input.value).pipe(toEffect));
        return result._tag === "ok"
          ? `${result.body.length} hit(s)\n${result.body.map((hit) => `${hit.type}  ${hit.id}`).join("\n")}`
          : show(result.body);
      },
    },
  ];

  return h(
    "div",
    {},
    h("div", { class: "fields" }, projectName.row, projectId.row, taskTitle.row),
    actionPanel(
      "Java business API, :4300",
      "Epoch-millisecond timestamps, two error shapes, a PATCH that answers with the past, an OData envelope, 64-bit ids, and a gateway that strips half the methods.",
      actions,
    ),
  );
};
