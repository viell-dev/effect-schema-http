/**
 * Renders uploaded attachments. Image attachments get an inline preview built from bytes fetched
 * through `getAttachmentBytes` (the `ResponseBody.uint8Array` endpoint) and wrapped in a `Blob`;
 * everything else gets a plain download link straight at the server (a real browser download,
 * not routed through the typed client — most apps just link to the file, and there's no reason
 * to route a plain download through `Schema.decode` when nothing needs to inspect the bytes).
 */
import { Effect, Schema } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { BundleMetadata, type AttachmentView } from "@realworld/domain";
import { h } from "../dom.js";
import { API_BASE_URL, getAttachmentBundle, getAttachmentBytes } from "../api.js";
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

/**
 * Fetches the same attachment through the multipart bundle endpoint — metadata and bytes in one
 * response — instead of the two requests the rest of this component makes. `ResponseBody.formData`
 * hands back a real `FormData`; what its parts *mean* is application knowledge, so the metadata
 * part is decoded here with the schema that describes it.
 */
const describeBundle = async (slug: string, attachment: AttachmentView): Promise<string> => {
  const result = await run(getAttachmentBundle({ slug, attachmentId: attachment.id }).pipe(toEffect));
  if (result._tag !== "ok") return "Could not load the bundle.";

  const form = result.body;
  const rawMetadata = form.get("metadata");
  const file = form.get("file");
  if (typeof rawMetadata !== "string" || !(file instanceof Blob)) return "Bundle was missing a part.";

  const metadata = await Effect.runPromise(Schema.decodeUnknown(Schema.parseJson(BundleMetadata))(rawMetadata));
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `${metadata.filename} · ${metadata.contentType} · ${metadata.size} B declared, ${bytes.length} B received`;
};

export const renderAttachment = (
  slug: string,
  attachment: AttachmentView,
  canDelete: boolean,
  onDelete: () => void,
): HTMLElement => {
  const downloadUrl = `${API_BASE_URL}/api/posts/${slug}/attachments/${attachment.id}`;
  const bundleLine = h("div", { class: "hint hidden" });
  const bundleButton = h(
    "button",
    {
      class: "link-button",
      onclick: () => {
        bundleLine.classList.remove("hidden");
        bundleLine.textContent = "Loading bundle…";
        void describeBundle(slug, attachment)
          .then((description) => {
            bundleLine.textContent = description;
          })
          .catch((error: unknown) => {
            console.error("attachment bundle failed", error);
            bundleLine.textContent = "Could not load the bundle.";
          });
      },
    },
    "Inspect bundle",
  );

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
      bundleButton,
      bundleLine,
    ),
    canDelete ? h("button", { class: "link-button", onclick: () => onDelete() }, "Delete") : null,
  );
};
