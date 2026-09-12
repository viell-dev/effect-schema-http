import { type DeclaredHeaderEntries, type HeaderValueInput } from "../request/types.js";

/** Replaces every exact occurrence of one header name/value pair. */
export const replaceHeaderEntryValue = (
  entries: DeclaredHeaderEntries,
  name: string,
  currentValue: string,
  replacementValue: HeaderValueInput,
): DeclaredHeaderEntries => {
  const canonicalName = name.toLowerCase();
  // A computed value has no value to match until it runs, so targeted replacement never selects one.
  return entries.map((entry) =>
    entry[0] === canonicalName && entry[1] === currentValue ? ([canonicalName, replacementValue] as const) : entry,
  );
};
