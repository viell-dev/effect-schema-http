import { type DeclaredQueryParams, type QueryParamValue } from "../types.js";

/** Removes only parameters carrying an exact static value. */
export const removeQueryParamValue = (
  params: DeclaredQueryParams,
  key: string,
  value: QueryParamValue,
): DeclaredQueryParams => params.filter(([candidate, candidateValue]) => candidate !== key || candidateValue !== value);
