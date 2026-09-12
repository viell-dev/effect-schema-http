import { type DeclaredQueryParams, type QueryParamsInput, type QueryParamValueInput } from "../types.js";

export const queryParamsFromInput = (input: QueryParamsInput): DeclaredQueryParams => {
  if (Symbol.iterator in input) {
    return Array.from(input, ([key, value]) => [key, value] as const);
  }

  return Object.entries(input).flatMap(([key, value]) => {
    if (value === undefined) return [];
    return Array.isArray(value)
      ? value.map((item) => [key, item] as const)
      : [[key, value as QueryParamValueInput] as const];
  });
};
