import { type DeclaredQueryParams } from "../types.js";

export const removeQueryParam = (params: DeclaredQueryParams, key: string): DeclaredQueryParams =>
  params.filter(([candidate]) => candidate !== key);
