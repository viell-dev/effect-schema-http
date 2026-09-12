import { type DeclaredQueryParams } from "../request/types.js";
import { parsePathQuery } from "./parsePathQuery.js";

export const splitPathUrlParams = (
  path: string,
): { readonly path: string; readonly urlParams: DeclaredQueryParams } => {
  const fragmentIndex = path.indexOf("#");
  const beforeFragment = fragmentIndex === -1 ? path : path.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : path.slice(fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  if (queryIndex === -1) return { path, urlParams: [] };

  return {
    path: `${beforeFragment.slice(0, queryIndex)}${fragment}`,
    urlParams: parsePathQuery(beforeFragment.slice(queryIndex + 1)),
  };
};
