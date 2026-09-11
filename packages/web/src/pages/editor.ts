import { DateTime, Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { CreatePostInput, type PostVisibility, UpdatePostInput } from "@realworld/domain";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { askAboutConflict } from "../components/conflictDialog.js";
import { createPost, getPost, updatePost } from "../api.js";
import { run } from "../runtime.js";
import { domainErrorMessage } from "../errors.js";
import { decodeForm } from "../decodeForm.js";
import { forceUpdate } from "../forceUpdate.js";
import { getSession } from "../session.js";
import { navigate } from "../router.js";

const VISIBILITIES: ReadonlyArray<PostVisibility> = ["public", "draft", "private"];

export const renderEditorPage = async (root: HTMLElement, editingSlug?: string): Promise<void> => {
  const session = getSession();
  if (!session) {
    navigate("/login");
    return;
  }

  const main = h("main", { class: "container container-narrow" }, h("p", {}, "Loading…"));
  mount(root, renderNav(), main);

  let initial: { title: string; body: string; visibility: PostVisibility } = {
    title: "",
    body: "",
    visibility: "public",
  };
  // The revision this editor was opened against, sent back with the save so the server can tell
  // whether anyone else has written since. Absent for a new post: there is nothing to conflict with.
  let loadedRevision: string | undefined;

  if (editingSlug) {
    const existing = await run(getPost({ slug: editingSlug }).pipe(toEffect)).catch(() => undefined);
    if (!existing) {
      mount(main, h("p", { class: "error" }, "Could not reach the server. Is it running?"));
      return;
    }
    const existingError = domainErrorMessage(existing);
    if (existingError) {
      mount(main, h("p", { class: "error" }, existingError));
      return;
    }
    if (existing._tag !== "ok") {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
      return;
    }
    if (existing.body.authorId !== session.profile.id) {
      mount(main, h("p", { class: "error" }, "You can only edit your own posts."));
      return;
    }
    initial = { title: existing.body.title, body: existing.body.body, visibility: existing.body.visibility };
    loadedRevision = DateTime.formatIso(existing.body.updatedAt);
  }

  const errorBox = h("p", { class: "error hidden" });
  const titleInput = h("input", { type: "text", name: "title", required: "true", value: initial.title });
  const bodyInput = h("textarea", { name: "body", rows: "10", required: "true" });
  bodyInput.value = initial.body;
  const visibilitySelect = h(
    "select",
    { name: "visibility" },
    ...VISIBILITIES.map((visibility) =>
      h(
        "option",
        { value: visibility, ...(visibility === initial.visibility ? { selected: "true" } : {}) },
        visibility,
      ),
    ),
  );

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

        const visibility = visibilitySelect.value as PostVisibility;

        if (editingSlug) {
          const decoded = decodeForm(UpdatePostInput, {
            title: titleInput.value,
            body: bodyInput.value,
            visibility,
          });
          if (decoded._tag === "failure") {
            showError(decoded.issues.join("; "));
            return;
          }
          // Built once and held. A conflict re-executes this very plan with one transform
          // applied, rather than assembling a second, near-identical request.
          const save = updatePost({ slug: editingSlug })
            .setBody(decoded.value)
            .setHeader("x-expected-revision", loadedRevision ?? "");

          const submit = async (plan: typeof save): Promise<void> => {
            const result = await run(plan.pipe(toEffect));

            // A 409 is a mapped response rule, so it arrives here as an ordinary typed value
            // alongside the success case — not as a thrown error to be caught and re-parsed.
            if (result._tag === "ConflictError") {
              const { force } = await askAboutConflict(result.body.message);
              if (!force) {
                showError("Your changes were not saved. Reload the page to see the other version.");
                return;
              }
              await submit(save.pipe(forceUpdate));
              return;
            }

            const message = domainErrorMessage(result);
            if (message) {
              showError(message);
              return;
            }
            Match.value(result).pipe(
              Match.tag("ok", ({ body }) => navigate(`/posts/${body.slug}`)),
              Match.orElse(() => showError("Unexpected response from the server.")),
            );
          };

          void submit(save).catch((error: unknown) => {
            console.error("post update failed", error);
            showError("Could not reach the server. Is it running?");
          });
          return;
        }

        const decoded = decodeForm(CreatePostInput, {
          title: titleInput.value,
          body: bodyInput.value,
          visibility,
        });
        if (decoded._tag === "failure") {
          showError(decoded.issues.join("; "));
          return;
        }
        void run(createPost().setBody(decoded.value).pipe(toEffect))
          .then((result) => {
            const message = domainErrorMessage(result);
            if (message) {
              showError(message);
              return;
            }
            Match.value(result).pipe(
              Match.tag("created", ({ body }) => navigate(`/posts/${body.slug}`)),
              Match.orElse(() => showError("Unexpected response from the server.")),
            );
          })
          .catch((error: unknown) => {
            console.error("post creation failed", error);
            showError("Could not reach the server. Is it running?");
          });
      },
    },
    h("h1", {}, editingSlug ? "Edit post" : "New post"),
    errorBox,
    h("label", {}, "Title", titleInput),
    h("label", {}, "Body", bodyInput),
    h("label", {}, "Visibility", visibilitySelect),
    h("button", { type: "submit" }, editingSlug ? "Save changes" : "Publish"),
  );

  mount(root, renderNav(), h("main", { class: "container container-narrow" }, form));
};
