import { toEffect } from "viell-effect-schema-http";
import { append, h } from "../dom.js";
import { run } from "../runtime.js";
import {
  createComment,
  createProject,
  createTask,
  deleteProject,
  listComments,
  listProjects,
  listTasks,
  patchProject,
} from "../services/apiClient.js";
import { getSession } from "../session.js";

export const renderProjectsView = (): HTMLElement => {
  const logBox = h("div", { class: "log-box" }, "Ready for project actions...");

  const appendLog = (msg: string) => {
    logBox.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n\n${logBox.textContent}`;
  };

  const projectListContainer = h("div", {}, "Click 'Refresh Projects' to load...");

  const loadProjects = async () => {
    try {
      projectListContainer.textContent = "Loading projects...";
      const res = await run(listProjects().pipe(toEffect));
      const projects = res.body;

      projectListContainer.replaceChildren();
      if (projects.length === 0) {
        projectListContainer.textContent = "No projects found. Create one!";
        return;
      }

      for (const p of projects) {
        const pCard = h(
          "div",
          { class: "item-card" },
          h(
            "div",
            { class: "item-header" },
            h("strong", {}, p.name),
            h(
              "div",
              { style: "display: flex; gap: 0.5rem;" },
              h(
                "button",
                {
                  class: "btn btn-outline",
                  onclick: async () => {
                    const newName = prompt("Enter new project name:", `${p.name} (Updated)`);
                    if (!newName) return;
                    try {
                      appendLog(`Sending PATCH /api/projects/${p.id} with name: "${newName}"...`);
                      const patchRes = await run(
                        patchProject({ id: p.id })
                          .setBody({ name: newName })
                          .pipe(toEffect),
                      );
                      appendLog(
                        `⚠️ QUIRK OBSERVED: PATCH returned OLD state!\nReturned name in response: "${patchRes.body.name}" (old name)\nNow re-fetching project to show actual database update...`,
                      );
                      await loadProjects();
                    } catch (err) {
                      appendLog(`✗ Patch failed: ${String(err)}`);
                    }
                  },
                },
                "Rename (Test PATCH Quirk)",
              ),
              h(
                "button",
                {
                  class: "btn btn-danger",
                  onclick: async () => {
                    if (!confirm(`Delete project "${p.name}"?`)) return;
                    try {
                      await run(deleteProject({ id: p.id }).pipe(toEffect));
                      appendLog(`✓ Deleted project ${p.id} (Quirk: 204 with JSON body)`);
                      await loadProjects();
                    } catch (err) {
                      appendLog(`✗ Delete failed: ${String(err)}`);
                    }
                  },
                },
                "Delete",
              ),
            ),
          ),
          h("div", { class: "item-meta" }, `Owner: ${p.owner} | Created: ${p.createdAt.toLocaleString()} (Quirk: decoded from epoch-ms number)`),
          h("p", { style: "margin: 0.5rem 0;" }, p.description),
          // Task section for this project
          renderTaskSection(p.id, appendLog),
        );
        projectListContainer.appendChild(pCard);
      }
    } catch (err) {
      projectListContainer.textContent = `Failed to load projects: ${String(err)}`;
      appendLog(`✗ Error loading projects: ${String(err)}`);
    }
  };

  const renderTaskSection = (projectId: string, log: (msg: string) => void): HTMLElement => {
    const taskContainer = h("div", { style: "margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 0.75rem;" });
    const taskList = h("div", {}, "Loading tasks...");

    const loadTasks = async () => {
      try {
        const res = await run(listTasks(projectId).pipe(toEffect));
        taskList.replaceChildren();
        if (res.body.length === 0) {
          taskList.textContent = "No tasks yet.";
          return;
        }
        for (const t of res.body) {
          taskList.appendChild(
            h(
              "div",
              { style: "background: var(--code-bg); padding: 0.5rem; border-radius: 4px; margin-bottom: 0.5rem;" },
              h("div", { style: "display: flex; justify-content: space-between;" },
                h("strong", {}, t.title),
                h("span", { class: "badge badge-rust" }, `Status: ${t.status}`),
              ),
              h("div", { class: "item-meta" }, `Assignee: ${t.assignee || "Unassigned"} | Quirk: Status sent as string "${t.status}", stored as int, decoded back to "${t.status}"`),
              renderCommentSection(t.id, log),
            ),
          );
        }
      } catch (err) {
        taskList.textContent = `Error loading tasks: ${String(err)}`;
      }
    };

    const taskTitleInput = h("input", { type: "text", placeholder: "New task title", style: "width: auto; flex: 1;" });
    const taskAddBtn = h("button", { class: "btn btn-primary" }, "Add Task");
    taskAddBtn.onclick = async () => {
      if (!taskTitleInput.value.trim()) return;
      try {
        log(`Creating task "${taskTitleInput.value}" with string status "OPEN"...`);
        const res = await run(
          createTask()
            .setBody({
              projectId,
              title: taskTitleInput.value.trim(),
              status: "OPEN",
            })
            .pipe(toEffect),
        );
        log(`✓ Created task (ID: ${res.body.id}). Quirk: request used string status "OPEN", response ordinal 0 transformed to "${res.body.status}".`);
        taskTitleInput.value = "";
        await loadTasks();
      } catch (err) {
        log(`✗ Create task failed: ${String(err)}`);
      }
    };

    void loadTasks();

    append(taskContainer, [
      h("div", { style: "display: flex; gap: 0.5rem; margin-bottom: 0.5rem;" }, taskTitleInput, taskAddBtn),
      taskList,
    ]);
    return taskContainer;
  };

  const renderCommentSection = (taskId: string, log: (msg: string) => void): HTMLElement => {
    const commentContainer = h("div", { style: "margin-top: 0.5rem; padding-left: 1rem; border-left: 2px solid var(--border);" });
    const commentList = h("div", {}, "Loading comments...");

    const loadComments = async () => {
      try {
        const res = await run(listComments(taskId).pipe(toEffect));
        commentList.replaceChildren();
        if (res.body.length === 0) {
          commentList.textContent = "No comments.";
          return;
        }
        for (const c of res.body) {
          commentList.appendChild(
            h("div", { style: "font-size: 0.85rem; margin-bottom: 0.25rem;" },
              h("span", { style: "font-weight: 600;" }, `${c.author}: `),
              h("span", {}, c.body),
            ),
          );
        }
      } catch (err) {
        commentList.textContent = `Error loading comments: ${String(err)}`;
      }
    };

    const commentInput = h("input", { type: "text", placeholder: "Write comment...", style: "width: auto; flex: 1; font-size: 0.8rem;" });
    const commentBtn = h("button", { class: "btn btn-outline", style: "font-size: 0.8rem; padding: 0.25rem 0.5rem;" }, "Comment");
    commentBtn.onclick = async () => {
      if (!commentInput.value.trim()) return;
      try {
        log(`Posting comment to task ${taskId}...`);
        const res = await run(
          createComment()
            .setBody({
              taskId,
              body: commentInput.value.trim(),
            })
            .pipe(toEffect),
        );
        log(`✓ Comment posted! Quirk: Server returned 200 OK (not 201 Created) with relative Location header.`);
        commentInput.value = "";
        await loadComments();
      } catch (err) {
        log(`✗ Post comment failed: ${String(err)}`);
      }
    };

    void loadComments();

    append(commentContainer, [
      h("div", { style: "display: flex; gap: 0.5rem; margin-bottom: 0.25rem;" }, commentInput, commentBtn),
      commentList,
    ]);
    return commentContainer;
  };

  // Create Project Form
  const projName = h("input", { type: "text", placeholder: "Project Name", value: "New Initiative" });
  const projDesc = h("input", { type: "text", placeholder: "Project Description", value: "A multi-service platform test" });
  const createProjBtn = h("button", { class: "btn btn-primary" }, "Create Project");
  createProjBtn.onclick = async () => {
    try {
      appendLog(`Creating project "${projName.value}"...`);
      const res = await run(
        createProject()
          .setBody({
            name: projName.value,
            description: projDesc.value,
          })
          .pipe(toEffect),
      );
      appendLog(`✓ Created project: ${res.body.id} at ${res.body.createdAt.toISOString()}`);
      await loadProjects();
    } catch (err) {
      appendLog(`✗ Create project failed (Ensure you are logged in!): ${String(err)}`);
    }
  };

  const refreshBtn = h("button", { class: "btn btn-outline" }, "Refresh Projects");
  refreshBtn.onclick = () => void loadProjects();

  return h(
    "div",
    {},
    h(
      "div",
      { class: "quirk-callout" },
      h("strong", {}, "Historical Quirks on API Server (Port 4300):"),
      h("br"),
      "1. Authorization header requires scheme 'Token <token>', NOT 'Bearer <token>' (pre-RFC 6750 legacy).",
      h("br"),
      "2. All timestamps are epoch milliseconds as JSON numbers (Java System.currentTimeMillis()).",
      h("br"),
      "3. PATCH on projects/tasks returns the OLD state, not the new state.",
      h("br"),
      "4. Task status: request sends string name ('OPEN'), response returns integer ordinal (0).",
      h("br"),
      "5. Creating comments returns 200 OK (not 201) and a relative Location header.",
      h("br"),
      "6. DELETE returns 204 No Content with a non-empty body {'deleted': true}.",
    ),
    h(
      "div",
      { class: "panel" },
      h("div", { class: "panel-title" }, "Create New Project"),
      h("div", { class: "form-group" }, h("label", {}, "Name"), projName),
      h("div", { class: "form-group" }, h("label", {}, "Description"), projDesc),
      h("div", { style: "display: flex; gap: 0.5rem;" }, createProjBtn, refreshBtn),
    ),
    h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Projects & Tasks"), projectListContainer),
    h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Activity Log"), logBox),
  );
};
