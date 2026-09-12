import { Headers } from "@effect/platform";
import { type HeaderEntries } from "../request/types.js";

/** Produces Effect Platform's normalized header map from ordered entries. */
export const normalizeHeaderEntries = (entries: HeaderEntries): Headers.Headers => {
  const grouped = Object.create(null) as Record<string, Array<string>>;
  for (const [name, value] of entries) (grouped[name] ??= []).push(value);
  return Headers.fromInput(grouped);
};
