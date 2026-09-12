import { type AnyResponseRule } from "../request/types.js";

export const specificity = (rule: AnyResponseRule): number =>
  Object.keys(rule.match.headers ?? {}).length * 2 + (typeof rule.match.status === "number" ? 1 : 0);
