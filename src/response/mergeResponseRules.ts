import { type AnyResponseRule } from "../request/types.js";

export const mergeResponseRules = (
  defaults: ReadonlyArray<AnyResponseRule>,
  overrides: ReadonlyArray<AnyResponseRule>,
): ReadonlyArray<AnyResponseRule> => [
  ...overrides,
  ...defaults.filter((rule) => !overrides.some((override) => override.match._tag === rule.match._tag)),
];
