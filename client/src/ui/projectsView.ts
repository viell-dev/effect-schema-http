import { DateTime, Effect } from "effect";
import { Request } from "viell-effect-schema-http";
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
          createProject().execute({
            body: { name: projectName.input.value, description: "created from the web client" },
          }),
        );
        if (result._tag !== "created") return `${result._tag}: ${show(result.value)}`;
        projectId.input.value = result.value.id;
        return `created ${result.value.id}\ncreatedAt arrived as epoch milliseconds and decoded to ${DateTime.formatIso(result.value.createdAt)}`;
      },
    },
    {
      label: "Rename it (PATCH)",
      note: "PATCH answers with the state the resource had before the write. Deliberately.",
      run: async () => {
        const renamed = `${projectName.input.value} (renamed)`;
        const patched = await run(
          patchProject().execute({ path: { id: projectId.input.value }, body: { name: renamed } }),
        );
        if (patched._tag !== "ok") return `${patched._tag}: ${show(patched.value)}`;
        const listed = await run(listProjects().execute(undefined));
        const current =
          listed._tag === "ok" ? listed.value.find((item) => item.id === projectId.input.value) : undefined;
        return `PATCH returned "${patched.value.name}"\nthe stored value is "${current?.name ?? "unknown"}"\n\nA developer read "return the resource" as "return what it was", and the mobile app now depends on it.`;
      },
    },
    {
      label: "Add a task",
      note: "The request sends a status name; the response answers with its ordinal.",
      run: async () => {
        const result = await run(
          createTask().execute({
            body: {
              projectId: projectId.input.value,
              title: taskTitle.input.value,
              status: "IN_PROGRESS",
              priority: 3,
            },
          }),
        );
        if (result._tag !== "created") return `${result._tag}: ${show(result.value)}`;
        return `created ${result.value.id}\nsent "IN_PROGRESS", received 1, decoded back to "${result.value.status}"`;
      },
    },
    {
      label: "List its tasks",
      note: "Plain JSON in and out — the case the library needs no configuration for at all.",
      run: async () => {
        const result = await run(listTasks(projectId.input.value));
        return result._tag === "ok"
          ? result.value.map((task) => `${task.id}  ${task.status.padEnd(12)} ${task.title}`).join("\n") || "no tasks"
          : show(result.value);
      },
    },
    {
      label: "Delete a task (blocked, then tunnelled)",
      note: "The gateway strips DELETE. The same plan works with X-HTTP-Method-Override.",
      run: async () => {
        const tasks = await run(listTasks(projectId.input.value));
        const target = tasks._tag === "ok" ? tasks.value[0] : undefined;
        if (target === undefined) return "no task to delete";
        const blocked = await run(deleteTask().execute({ path: { id: target.id } }));
        const tunnelled = await run(
          deleteTask({ request: (request) => request.pipe(tunnelMethod("DELETE")) }).execute({
            path: { id: target.id },
          }),
        );
        return `raw DELETE:   ${blocked._tag} (${blocked.metadata.status})\ntunnelled:    ${tunnelled._tag} (${tunnelled.metadata.status})`;
      },
    },
    {
      label: "Conditional read and write",
      note: "The one endpoint here that is correct: a strong ETag, a real 304, and a 412.",
      run: async () => {
        const first = await run(getVersionedProject().execute({ path: { id: projectId.input.value } }));
        if (first._tag !== "ok") return `${first._tag}: ${show(first.value)}`;
        const etag = first.metadata.headers.etag ?? "";
        const repeated = await run(
          getVersionedProject({ request: (request) => request.pipe(Request.setHeader("if-none-match", etag)) }).execute(
            { path: { id: projectId.input.value } },
          ),
        );
        const stale = await run(
          putVersionedProject({
            request: (request) => request.pipe(Request.setHeader("if-match", '"stale"'), tunnelMethod("PUT")),
          }).execute({ path: { id: projectId.input.value }, body: { name: "should not apply" } }),
        );
        const written = await run(
          putVersionedProject({
            request: (request) => request.pipe(Request.setHeader("if-match", etag), tunnelMethod("PUT")),
          }).execute({
            path: { id: projectId.input.value },
            body: { name: `${projectName.input.value} (conditional)` },
          }),
        );
        return [
          `read:            200 with ETag ${etag}`,
          `If-None-Match:   ${repeated._tag} (${repeated.metadata.status}), body ${String(repeated.value)}`,
          `stale If-Match:  ${stale._tag} (${stale.metadata.status})`,
          `fresh If-Match:  ${written._tag} (${written.metadata.status})`,
        ].join("\n");
      },
    },
    {
      label: "Read the orders (64-bit ids)",
      note: "Read as text and parsed with a different JSON dialect, because JSON.parse rounds them.",
      run: async () => {
        const result = await run(listOrders().execute(undefined));
        if (result._tag !== "ok") return show(result.value);
        const first = result.value.orders[0];
        if (first === undefined) return "no orders";
        return [
          `id kept exact:     ${first.id}`,
          `JSON.parse gives:  ${String(Number(first.id))}`,
          `amount:            ${first.amount} cents, from "${"$" + (first.amount / 100).toLocaleString("en-US")}"`,
          `orderDate:         ${DateTime.formatIso(first.orderDate)} from an ASP.NET /Date()/`,
          `cancelledOn:       ${first.cancelledOn === null ? "null, from the MySQL zero date" : DateTime.formatIso(first.cancelledOn)}`,
          `creditLimit:       ${show(first.creditLimit)}`,
          `customerRef:       ${show(first.customerRef)}`,
          `total:             ${result.value.total} (arrived as the string "__count" inside a "d" envelope)`,
        ].join("\n");
      },
    },
    {
      label: "Read the report grid",
      note: "Positional rows behind an unregistered text/json content type, checked against their header.",
      run: async () => {
        const result = await run(gridReport().execute(undefined));
        if (result._tag !== "ok") return show(result.value);
        return (
          result.value.rows
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
          batchGet().execute({
            body: {
              requests: [
                { id: "mine", path: `/api/projects/${projectId.input.value}` },
                { id: "gone", path: "/api/projects/does-not-exist" },
                { id: "odd", path: "/api/unsupported" },
              ],
            },
          }),
        );
        if (result._tag !== "ok") return show(result.value);
        return result.value.responses
          .map((item) =>
            item._tag === "found"
              ? `${item.id}: found ${item.project.name}`
              : `${item.id}: ${item.status} ${item.code}`,
          )
          .join("\n");
      },
    },
    {
      label: "Start an import and follow it",
      note: "202 with a relative Location, then a poll that is a loop over a cold plan, not a retry.",
      run: async () => {
        const accepted = await run(startImport().execute({ body: { source: "web.csv" } }));
        if (accepted._tag !== "accepted") return show(accepted.value);
        const resolved = new URL(accepted.metadata.headers.location ?? "", "http://localhost:4300");
        const trail = [`202 Location: ${accepted.metadata.headers.location} -> ${resolved.href}`];
        const poll = Effect.promise(() => run(importStatus().execute({ path: { id: accepted.value.id } })));
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const status = await Effect.runPromise(poll);
          if (status._tag !== "ok") return `${trail.join("\n")}\n${show(status.value)}`;
          trail.push(`poll ${attempt + 1}: ${status.value.state} ${status.value.progress}%`);
          if (status.value.state === "done") break;
        }
        return trail.join("\n");
      },
    },
    {
      label: "Look something up (errors in a header)",
      note: "Two rules at 200 separated only by X-Error-Code; the header-bearing one ranks first.",
      run: async () => {
        const good = await run(
          lookup({ request: (request) => request.pipe(Request.setQuery("q", projectName.input.value)) }).execute(
            undefined,
          ),
        );
        const bad = await run(
          lookup({ request: (request) => request.pipe(Request.setQuery("q", 'name:"unbalanced')) }).execute(undefined),
        );
        return [
          `plain query:  ${good._tag} (${good.metadata.status})`,
          good._tag === "ok" ? `  ${good.value.matches.length} match(es)` : "",
          `bad syntax:   ${bad._tag} (${bad.metadata.status})`,
          bad._tag === "LookupSyntaxError" ? `  ${bad.value.message}` : "",
        ]
          .filter((line) => line !== "")
          .join("\n");
      },
    },
    {
      label: "Page through projects",
      note: "The query parameter is 1-based; the Link header is 0-based. Both are the contract.",
      run: async () => {
        const first = await run(
          listProjectsPage({
            request: (request) => request.pipe(Request.setQuery("page", "1"), Request.setQuery("pageSize", "2")),
          }).execute(undefined),
        );
        if (first._tag !== "ok") return show(first.value);
        return [
          `X-Total-Count: ${first.metadata.headers["x-total-count"]}`,
          `Link: ${first.metadata.headers.link}`,
          "",
          ...first.value.map((project) => `${project.id}  ${project.name}`),
        ].join("\n");
      },
    },
    {
      label: "Search (one hit is not an array)",
      note: "Jackson's WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED, normalized by a union in the schema.",
      run: async () => {
        const result = await run(search(taskTitle.input.value));
        return result._tag === "ok"
          ? `${result.value.length} hit(s)\n${result.value.map((hit) => `${hit.type}  ${hit.id}`).join("\n")}`
          : show(result.value);
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
