import { type DeclaredHeaderEntries } from "../request/types.js";

/** Removes all fields by name, or only fields having an exact static value. */
export const removeHeaderEntry = (
  entries: DeclaredHeaderEntries,
  name: string,
  value?: string,
): DeclaredHeaderEntries => {
  const canonicalName = name.toLowerCase();
  return entries.filter(
    ([candidateName, candidateValue]) =>
      candidateName !== canonicalName || (value !== undefined && candidateValue !== value),
  );
};
