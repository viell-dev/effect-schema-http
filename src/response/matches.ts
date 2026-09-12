import { Headers } from "@effect/platform";
import { type AnyResponseRule, type HeaderEntries } from "../request/types.js";

export const matches = (
  rule: AnyResponseRule,
  status: number,
  headers: Headers.Headers,
  headerEntries: HeaderEntries,
): boolean => {
  const statusMatches =
    typeof rule.match.status === "number" ? rule.match.status === status : rule.match.status(status);
  return (
    statusMatches &&
    Object.entries(rule.match.headers ?? {}).every(([name, matcher]) => {
      const canonicalName = name.toLowerCase();
      const value = headers[canonicalName];
      const values = headerEntries
        .filter(([candidate]) => candidate === canonicalName)
        .map(([, candidateValue]) => candidateValue);
      return typeof matcher === "string" ? value === matcher : matcher(value, values);
    })
  );
};
