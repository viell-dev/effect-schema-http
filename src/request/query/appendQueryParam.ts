import { type DeclaredQueryParams, type QueryParamValueInput } from "../types.js";

export const appendQueryParam = (
  params: DeclaredQueryParams,
  key: string,
  value: QueryParamValueInput,
): DeclaredQueryParams => [...params, [key, value]];
