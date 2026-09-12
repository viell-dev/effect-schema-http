import { type DeclaredQueryParams, type QueryParamValueInput } from "../types.js";
import { setQueryParams } from "./setQueryParams.js";

export const setQueryParam = (
  params: DeclaredQueryParams,
  key: string,
  value: QueryParamValueInput,
): DeclaredQueryParams => setQueryParams(params, [[key, value]]);
