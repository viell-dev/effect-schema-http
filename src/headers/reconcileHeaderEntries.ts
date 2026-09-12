import { Headers } from "@effect/platform";
import { type HeaderEntries } from "../request/types.js";
import { normalizeHeaderEntries } from "./normalizeHeaderEntries.js";

/** Reconciles provider-preserved entries with request transforms applied to normalized headers. */
export const reconcileHeaderEntries = (entries: HeaderEntries, headers: Headers.Headers): HeaderEntries => {
  const normalized = normalizeHeaderEntries(entries);
  const names = new Set<string>();
  const reconciled: Array<readonly [string, string]> = [];

  for (const [name] of entries) {
    if (names.has(name)) continue;
    names.add(name);
    const value = headers[name];
    if (value === undefined) continue;
    if (normalized[name] === value) {
      reconciled.push(...entries.filter(([candidate]) => candidate === name));
    } else {
      reconciled.push([name, value]);
    }
  }

  for (const [name, value] of Object.entries(headers)) {
    if (!names.has(name)) reconciled.push([name, value]);
  }

  return reconciled;
};
