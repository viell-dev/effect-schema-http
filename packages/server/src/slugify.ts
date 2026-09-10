import { Slug, type PostTitle } from "@realworld/domain";

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

/** Deliberately not an `Effect Schema` transform: this is one-directional (title -> slug) and
 * lossy, so it does not fit the roughly-invertible decode/encode contract `Schema.transform`
 * is meant for. It stays a plain function that produces a value the `Slug` schema then validates. */
export const slugify = (title: PostTitle): Slug => {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
  return Slug.make(base.length > 0 ? base : "post");
};
