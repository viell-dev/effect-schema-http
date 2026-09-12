import { type AnyResponseRule } from "../request/types.js";

export const setResponseRule = (
  rules: ReadonlyArray<AnyResponseRule>,
  rule: AnyResponseRule,
): ReadonlyArray<AnyResponseRule> => {
  const index = rules.findIndex((candidate) => candidate.match._tag === rule.match._tag);
  if (index === -1) return [rule, ...rules];
  return rules.map((candidate, candidateIndex) => (candidateIndex === index ? rule : candidate));
};
