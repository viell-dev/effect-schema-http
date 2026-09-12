import { type DeclaredQueryParams, type QueryParamRemoval } from "../types.js";
import { removeQueryParam } from "./removeQueryParam.js";
import { removeQueryParamValue } from "./removeQueryParamValue.js";

export const removeQueryParams = (
  params: DeclaredQueryParams,
  removals: ReadonlyArray<QueryParamRemoval> | undefined,
): DeclaredQueryParams =>
  (removals ?? []).reduce(
    (current, removal) =>
      typeof removal === "string"
        ? removeQueryParam(current, removal)
        : removal.value === undefined
          ? removeQueryParam(current, removal.name)
          : removeQueryParamValue(current, removal.name, removal.value),
    params,
  );
