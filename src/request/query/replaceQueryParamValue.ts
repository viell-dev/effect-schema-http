import { type DeclaredQueryParams, type QueryParamValue, type QueryParamValueInput } from "../types.js";

export const replaceQueryParamValue = (
  params: DeclaredQueryParams,
  key: string,
  currentValue: QueryParamValue,
  replacementValue: QueryParamValueInput,
): DeclaredQueryParams =>
  // A computed value has no value to match until it runs, so targeted replacement never selects one.
  params.map((entry) => (entry[0] === key && entry[1] === currentValue ? ([key, replacementValue] as const) : entry));
