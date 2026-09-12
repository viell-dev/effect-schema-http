import { type DeclaredQueryParams, type QueryParamsInput } from "../types.js";
import { queryParamsFromInput } from "./queryParamsFromInput.js";

export const setQueryParams = (params: DeclaredQueryParams, input: QueryParamsInput): DeclaredQueryParams => {
  const incoming = queryParamsFromInput(input);
  const keys = new Set(incoming.map(([key]) => key));
  return [...incoming, ...params.filter(([key]) => !keys.has(key))];
};
