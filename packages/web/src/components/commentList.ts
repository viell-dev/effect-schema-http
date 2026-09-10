import { DateTime, Match } from "effect";
import type { CommentView } from "@realworld/domain";
import { h } from "../dom.js";

const formatDate = (value: DateTime.Utc): string => new Date(DateTime.toEpochMillis(value)).toLocaleString();

export const renderComment = (comment: CommentView, canDelete: boolean, onDelete: () => void): HTMLElement =>
  h(
    "article",
    { class: "comment" },
    h(
      "p",
      { class: "post-meta" },
      Match.value(comment.author).pipe(
        Match.tag("registered", (author) => h("a", { href: `#/blog/${author.username}` }, author.username)),
        Match.tag("anonymous", (author) => h("span", { class: "badge" }, `${author.displayName} (guest)`)),
        Match.exhaustive,
      ),
      ` · ${formatDate(comment.createdAt)}`,
      canDelete
        ? h(
            "button",
            {
              class: "link-button",
              onclick: () => onDelete(),
            },
            "Delete",
          )
        : null,
    ),
    h("p", {}, comment.body),
  );
