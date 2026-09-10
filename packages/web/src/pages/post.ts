import { DateTime, Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { CreateCommentInput } from "@realworld/domain";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { renderComment } from "../components/commentList.js";
import { createComment, deleteComment, deletePost, getPost, listComments } from "../api.js";
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

  const [postResult, commentsResult] = await Promise.all([
    run(withAuth(getPost({ slug })).pipe(toEffect)).catch((error: unknown) => {
      console.error("post request failed", error);
      return undefined;
    }),
    run(withAuth(listComments({ slug })).pipe(toEffect)).catch((error: unknown) => {
      console.error("comments request failed", error);
      return undefined;
    }),
  ]);

  if (!postResult || !commentsResult) {
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
        void run(withAuth(deleteComment({ slug, commentId })).pipe(toEffect))
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
                      void run(withAuth(deletePost({ slug })).pipe(toEffect))
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
