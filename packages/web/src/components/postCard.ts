import { DateTime } from "effect";
import type { PostView } from "@realworld/domain";
import { h } from "../dom.js";

const formatDate = (value: DateTime.Utc): string => new Date(DateTime.toEpochMillis(value)).toLocaleString();

export const renderPostCard = (post: PostView): HTMLElement =>
  h(
    "article",
    { class: "post-card" },
    h(
      "header",
      {},
      h("a", { class: "post-title", href: `#/posts/${post.slug}` }, post.title),
      post.visibility !== "public" ? h("span", { class: `badge badge-${post.visibility}` }, post.visibility) : null,
    ),
    h(
      "p",
      { class: "post-meta" },
      h("a", { href: `#/blog/${post.authorUsername}` }, post.authorUsername),
      ` · ${formatDate(post.createdAt)} · ${post.commentCount} comment${post.commentCount === 1 ? "" : "s"}`,
    ),
    h("p", { class: "post-excerpt" }, post.body.length > 200 ? `${post.body.slice(0, 200)}…` : post.body),
  );
