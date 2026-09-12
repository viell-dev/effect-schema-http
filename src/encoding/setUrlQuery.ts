import { type QueryParams } from "../request/types.js";
import { encodeQueryParam } from "./encodeQueryParam.js";

export const setUrlQuery = (url: string, params: QueryParams, encode = encodeQueryParam): string => {
  if (params.length === 0) return url;

  const fragmentIndex = url.indexOf("#");
  const beforeFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : url.slice(fragmentIndex);
  const separator = beforeFragment.includes("?") ? (beforeFragment.endsWith("?") ? "" : "&") : "?";
  return `${beforeFragment}${separator}${params.map(encode).join("&")}${fragment}`;
};
