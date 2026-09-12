import { type DeclaredQueryParams, type QueryParamValueInput } from "../types.js";

export const setQueryParam = (
  params: DeclaredQueryParams,
  key: string,
  value: QueryParamValueInput,
): DeclaredQueryParams => [...params.filter(([candidate]) => candidate !== key), [key, value]];
