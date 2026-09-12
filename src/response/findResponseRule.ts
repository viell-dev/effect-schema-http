import { Headers } from "@effect/platform";
import { type AnyResponseRule, type HeaderEntries } from "../request/types.js";
import { matches } from "./matches.js";
import { specificity } from "./specificity.js";

export const findResponseRule = (
  rules: ReadonlyArray<AnyResponseRule>,
  status: number,
  headers: Headers.Headers,
  headerEntries: HeaderEntries,
): AnyResponseRule | undefined => {
  let selected: AnyResponseRule | undefined;
  let selectedSpecificity = -1;

  for (const rule of rules) {
    const ruleSpecificity = specificity(rule);
    if (matches(rule, status, headers, headerEntries) && ruleSpecificity > selectedSpecificity) {
      selected = rule;
      selectedSpecificity = ruleSpecificity;
    }
  }

  return selected;
};
