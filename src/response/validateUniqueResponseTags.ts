import { DuplicateResponseTag } from "../errors/DuplicateResponseTag.js";
import { type AnyResponseRule } from "../request/types.js";

export const validateUniqueResponseTags = (rules: ReadonlyArray<AnyResponseRule>, owner: "api" | "request"): void => {
  const tags = new Set<string>();
  for (const rule of rules) {
    if (tags.has(rule.match._tag)) throw new DuplicateResponseTag(rule.match._tag, owner);
    tags.add(rule.match._tag);
  }
};
