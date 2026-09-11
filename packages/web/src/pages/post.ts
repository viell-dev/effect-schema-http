import { DateTime, Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { CreateCommentInput } from "@realworld/domain";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderComment } from "../components/commentList.js";
import { renderAttachment } from "../components/attachmentList.js";
import {
  createComment,
  deleteAttachment,
  deleteComment,
  deletePost,
  getPost,
  listAttachments,
  listComments,
  uploadAttachment,
} from "../api.js";
import { run } from "../runtime.js";
import { withAuth } from "../withAuth.js";
import { domainErrorMessage } from "../errors.js";
import { decodeForm } from "../decodeForm.js";
import { getSession } from "../session.js";
import { navigate } from "../router.js";

const formatDate = (value: DateTime.Utc): string => new Date(DateTime.toEpochMillis(value)).toLocaleString();

export const renderPostPage = async (root: HTMLElement, slug: string): Promise<void> => {
  const main = h("main", { class: "container" }, h("p", {}, "Loading post…"));
  mount(root, renderNav(), main);

  const rerender = () => void renderPostPage(root, slug);

  const [postResult, commentsResult, attachmentsResult] = await Promise.all([
    run(getPost({ slug }).pipe(withAuth, toEffect)).catch((error: unknown) => {
      console.error("post request failed", error);
      return undefined;
    }),
    run(listComments({ slug }).pipe(withAuth, toEffect)).catch((error: unknown) => {
      console.error("comments request failed", error);
      return undefined;
    }),
    run(listAttachments({ slug }).pipe(withAuth, toEffect)).catch((error: unknown) => {
      console.error("attachments request failed", error);
      return undefined;
    }),
  ]);

  if (!postResult || !commentsResult || !attachmentsResult) {
    mount(main, h("p", { class: "error" }, "Could not reach the server. Is it running?"));
    return;
  }

  const postError = domainErrorMessage(postResult);
  if (postError) {
    mount(main, h("p", { class: "error" }, postError));
    return;
  }

  Match.value(postResult).pipe(
    Match.tag("ok", ({ body: post }) => {
      const session = getSession();
      const isOwner = session?.profile.id === post.authorId;
      const comments =
        commentsResult._tag === "ok" ? commentsResult.body.comments : ([] as ReadonlyArray<never>);
      const attachments =
        attachmentsResult._tag === "ok" ? attachmentsResult.body.attachments : ([] as ReadonlyArray<never>);

      const commentBodyInput = h("textarea", { name: "body", rows: "3", required: "true" });
      const guestNameInput = session ? null : h("input", { type: "text", name: "displayName", required: "true" });
      const commentError = h("p", { class: "error hidden" });

      const showCommentError = (message: string): void => {
        commentError.textContent = message;
        commentError.classList.remove("hidden");
      };

      const commentForm = h(
        "form",
        {
          class: "card form",
          onsubmit: (event: Event) => {
            event.preventDefault();
            commentError.classList.add("hidden");

            const decoded = decodeForm(CreateCommentInput, {
              body: commentBodyInput.value,
              displayName: guestNameInput ? guestNameInput.value || undefined : undefined,
            });
            if (decoded._tag === "failure") {
              showCommentError(decoded.issues.join("; "));
              return;
            }

            void run(withAuth(createComment({ slug })).setBody(decoded.value).pipe(toEffect))
              .then((result) => {
                const message = domainErrorMessage(result);
                if (message) {
                  showCommentError(message);
                  return;
                }
                Match.value(result).pipe(
                  Match.tag("created", () => rerender()),
                  Match.orElse(() => showCommentError("Unexpected response from the server.")),
                );
              })
              .catch((error: unknown) => {
                console.error("comment submission failed", error);
                showCommentError("Could not reach the server. Is it running?");
              });
          },
        },
        h("h2", {}, "Add a comment"),
        commentError,
        guestNameInput ? h("label", {}, "Your name", guestNameInput) : null,
        h("label", {}, "Comment", commentBodyInput),
        h("button", { type: "submit" }, "Post comment"),
      );

      const deleteComment_ = (commentId: string) => {
        void run(deleteComment({ slug, commentId }).pipe(withAuth, toEffect))
          .then((result) => {
            const message = domainErrorMessage(result);
            if (message) {
              window.alert(message);
              return;
            }
            rerender();
          })
          .catch((error: unknown) => {
            console.error("comment deletion failed", error);
            window.alert("Could not reach the server. Is it running?");
          });
      };

      const deleteAttachment_ = (attachmentId: string) => {
        void run(deleteAttachment({ slug, attachmentId }).pipe(withAuth, toEffect))
          .then((result) => {
            const message = domainErrorMessage(result);
            if (message) {
              window.alert(message);
              return;
            }
            rerender();
          })
          .catch((error: unknown) => {
            console.error("attachment deletion failed", error);
            window.alert("Could not reach the server. Is it running?");
          });
      };

      const attachmentError = h("p", { class: "error hidden" });
      const fileInput = h("input", { type: "file", name: "file", required: "true" });
      const captionInput = h("input", { type: "text", name: "caption" });

      const showAttachmentError = (message: string): void => {
        attachmentError.textContent = message;
        attachmentError.classList.remove("hidden");
      };

      const uploadForm = h(
        "form",
        {
          class: "card form",
          onsubmit: (event: Event) => {
            event.preventDefault();
            attachmentError.classList.add("hidden");
            const file = fileInput.files?.[0];
            if (!file) {
              showAttachmentError("Choose a file first.");
              return;
            }

            const formData = new FormData();
            formData.set("file", file);
            if (captionInput.value) formData.set("caption", captionInput.value);

            void run(withAuth(uploadAttachment({ slug })).setBody(formData).pipe(toEffect))
              .then((result) => {
                const message = domainErrorMessage(result);
                if (message) {
                  showAttachmentError(message);
                  return;
                }
                Match.value(result).pipe(
                  Match.tag("created", () => rerender()),
                  Match.orElse(() => showAttachmentError("Unexpected response from the server.")),
                );
              })
              .catch((error: unknown) => {
                console.error("attachment upload failed", error);
                showAttachmentError("Could not reach the server. Is it running?");
              });
          },
        },
        h("h2", {}, "Add an attachment"),
        attachmentError,
        h("label", {}, "File", fileInput),
        h("label", {}, "Caption (optional)", captionInput),
        h("button", { type: "submit" }, "Upload"),
      );

      mount(
        main,
        h(
          "article",
          { class: "post-detail" },
          h(
            "header",
            {},
            h("h1", {}, post.title),
            post.visibility !== "public" ? h("span", { class: `badge badge-${post.visibility}` }, post.visibility) : null,
          ),
          h(
            "p",
            { class: "post-meta" },
            h("a", { href: `#/blog/${post.authorUsername}` }, post.authorUsername),
            ` · ${formatDate(post.createdAt)}`,
          ),
          ...post.body.split("\n").map((paragraph) => h("p", {}, paragraph)),
          isOwner
            ? h(
                "p",
                { class: "actions" },
                h("a", { href: `#/posts/${post.slug}/edit` }, "Edit"),
                h(
                  "button",
                  {
                    class: "link-button",
                    onclick: () => {
                      if (!window.confirm("Delete this post?")) return;
                      void run(deletePost({ slug }).pipe(withAuth, toEffect))
                        .then((result) => {
                          const message = domainErrorMessage(result);
                          if (message) {
                            window.alert(message);
                            return;
                          }
                          navigate(`/blog/${post.authorUsername}`);
                        })
                        .catch((error: unknown) => {
                          console.error("post deletion failed", error);
                          window.alert("Could not reach the server. Is it running?");
                        });
                    },
                  },
                  "Delete",
                ),
              )
            : null,
        ),
        h("h2", {}, `Attachments (${attachments.length})`),
        attachments.length === 0
          ? h("p", { class: "empty" }, "No attachments yet.")
          : h(
              "div",
              { class: "attachment-list" },
              ...attachments.map((attachment) => renderAttachment(slug, attachment, isOwner, () => deleteAttachment_(attachment.id))),
            ),
        isOwner ? uploadForm : null,
        h("h2", {}, `Comments (${comments.length})`),
        comments.length === 0
          ? h("p", { class: "empty" }, "No comments yet.")
          : h(
              "div",
              { class: "comment-list" },
              ...comments.map((comment) =>
                renderComment(
                  comment,
                  session !== undefined &&
                    (isOwner || (comment.author._tag === "registered" && comment.author.userId === session.profile.id)),
                  () => deleteComment_(comment.id),
                ),
              ),
            ),
        commentForm,
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
