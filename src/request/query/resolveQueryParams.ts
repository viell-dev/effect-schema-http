import { type DeclaredQueryParams, type QueryParams } from "../types.js";

/**
 * Calls every computed parameter value once and drops the parameters whose value resolved to `undefined`.
 *
 * @remarks
 * Runs while the request is materialized, after all declarative composition and before request transforms, so a
 * parameter removed by a declaration is never computed at all.
 */
export const resolveQueryParams = (params: DeclaredQueryParams): QueryParams =>
  params.flatMap(([key, value]) => {
    if (typeof value !== "function") return [[key, value] as const];
    const resolved = value();
    return resolved === undefined ? [] : [[key, resolved] as const];
  });
