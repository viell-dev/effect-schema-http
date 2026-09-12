import { type DeclaredHeaderEntries, type HeaderValueInput } from "../request/types.js";

/** Appends one header field without replacing existing values. */
export const appendHeaderEntry = (
  entries: DeclaredHeaderEntries,
  name: string,
  value: HeaderValueInput,
): DeclaredHeaderEntries => [...entries, [name.toLowerCase(), value]];
