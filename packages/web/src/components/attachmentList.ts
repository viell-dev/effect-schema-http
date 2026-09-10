/**
 * Renders uploaded attachments. Image attachments get an inline preview built from bytes fetched
 * through `getAttachmentBytes` (the `ResponseBody.uint8Array` endpoint) and wrapped in a `Blob`;
 * everything else gets a plain download link straight at the server (a real browser download,
 * not routed through the typed client — most apps just link to the file, and there's no reason
 * to route a plain download through `Schema.decode` when nothing needs to inspect the bytes).
 */
import { toEffect } from "viell-effect-schema-http";
import type { AttachmentView } from "@realworld/domain";
import { h } from "../dom.js";
import { API_BASE_URL, getAttachmentBytes } from "../api.js";
import { run } from "../runtime.js";

const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

const renderPreview = (slug: string, attachment: AttachmentView): HTMLElement | null => {
  if (!attachment.contentType.startsWith("image/")) return null;
  const img = h("img", { alt: attachment.filename });
  void run(getAttachmentBytes({ slug, attachmentId: attachment.id }).pipe(toEffect))
    .then((result) => {
      if (result._tag !== "ok") return;
      const blob = new Blob([new Uint8Array(result.body)], {
        type: result.headers["content-type"] ?? attachment.contentType,
      });
      img.src = URL.createObjectURL(blob);
    })
    .catch((error: unknown) => console.error("attachment preview failed", error));
  return img;
};

export const renderAttachment = (
  slug: string,
  attachment: AttachmentView,
  canDelete: boolean,
  onDelete: () => void,
): HTMLElement => {
  const downloadUrl = `${API_BASE_URL}/api/posts/${slug}/attachments/${attachment.id}`;
  return h(
    "div",
    { class: "attachment" },
    renderPreview(slug, attachment),
    h(
      "div",
      { class: "attachment-meta" },
      h("a", { href: downloadUrl }, attachment.filename),
      ` (${formatSize(attachment.size)})`,
      attachment.caption ? h("div", {}, attachment.caption) : null,
    ),
    canDelete ? h("button", { class: "link-button", onclick: () => onDelete() }, "Delete") : null,
  );
};
