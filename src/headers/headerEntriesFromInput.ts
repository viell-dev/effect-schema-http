import { type DeclaredHeaderEntries, type HeaderInput, type HeaderValueInput } from "../request/types.js";

/** Converts supported header input into canonical lower-case entries, retaining computed values unresolved. */
export const headerEntriesFromInput = (input: HeaderInput | undefined): DeclaredHeaderEntries => {
  if (input === undefined) return [];
  if (Symbol.iterator in input) {
    return Array.from(input, ([name, value]) => [name.toLowerCase(), value] as const);
  }

  return Object.entries(input).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return Array.isArray(value)
      ? value.map((item) => [name.toLowerCase(), item] as const)
      : [[name.toLowerCase(), value as HeaderValueInput] as const];
  });
};
