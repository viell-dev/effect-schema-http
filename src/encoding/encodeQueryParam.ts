import { type QueryParamValue } from "../request/types.js";

export const encodeQueryParam = ([key, value]: readonly [string, QueryParamValue]): string => {
  const encoded = new URLSearchParams([[key, value === true ? "" : value]]).toString();
  return value === true ? encoded.slice(0, -1) : encoded;
};
