import { type DeclaredHeaderEntries, type HeaderInput } from "../request/types.js";
import { headerEntriesFromInput } from "./headerEntriesFromInput.js";

/** Replaces all existing values for names present in the incoming input. */
export const setHeaderEntries = (entries: DeclaredHeaderEntries, input: HeaderInput): DeclaredHeaderEntries => {
  const incoming = headerEntriesFromInput(input);
  const names = new Set(incoming.map(([name]) => name));
  return [...incoming, ...entries.filter(([name]) => !names.has(name))];
};
