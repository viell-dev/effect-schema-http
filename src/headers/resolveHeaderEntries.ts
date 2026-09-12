import { type DeclaredHeaderEntries, type HeaderEntries } from "../request/types.js";

/**
 * Calls every computed header value once and drops the fields whose value resolved to `undefined`.
 *
 * @remarks
 * Runs while the request is materialized, after all declarative composition and before request transforms, so a field
 * removed by a declaration is never computed at all.
 */
export const resolveHeaderEntries = (entries: DeclaredHeaderEntries): HeaderEntries =>
  entries.flatMap(([name, value]) => {
    if (typeof value !== "function") return [[name, value] as const];
    const resolved = value();
    return resolved === undefined ? [] : [[name, resolved] as const];
  });
