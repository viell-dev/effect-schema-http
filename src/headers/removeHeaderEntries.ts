import { type DeclaredHeaderEntries, type HeaderRemoval } from "../request/types.js";
import { removeHeaderEntry } from "./removeHeaderEntry.js";

/** Applies ordered header removals. */
export const removeHeaderEntries = (
  entries: DeclaredHeaderEntries,
  removals: ReadonlyArray<HeaderRemoval> | undefined,
): DeclaredHeaderEntries =>
  (removals ?? []).reduce(
    (current, removal) =>
      typeof removal === "string"
        ? removeHeaderEntry(current, removal)
        : removeHeaderEntry(current, removal.name, removal.value),
    entries,
  );
