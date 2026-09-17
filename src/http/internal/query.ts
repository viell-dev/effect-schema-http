import { HttpClientRequest } from "@effect/platform";
import { Context } from "effect";
import type * as Url from "../Url.js";

/** Tuple identity lets native query replacements distinguish a flag from an empty value. */
export class Flags extends Context.Reference<Flags>()("viell-effect-schema-http/internal/QueryFlags", {
  defaultValue: () => new WeakSet<readonly [string, string]>(),
}) {}

export const set = (
  request: HttpClientRequest.HttpClientRequest,
  entries: Url.Query,
  flags: WeakSet<readonly [string, string]>,
) => {
  const updated = HttpClientRequest.setUrlParams(
    request,
    entries.map(([key, value]) => [key, value ?? ""] as const),
  );
  const offset = updated.urlParams.length - entries.length;
  entries.forEach(([, value], index) => {
    if (value === null) flags.add(updated.urlParams[offset + index]);
  });
  return updated;
};
