import { Headers, HttpClientRequest } from "@effect/platform";
import { Context, Effect } from "effect";

export type Lines = ReadonlyArray<readonly [string, string]>;

/** Per-evaluation wire details for providers that support repeated physical header lines. */
export class HeaderLines extends Context.Reference<HeaderLines>()("viell-effect-schema-http/Transport/HeaderLines", {
  defaultValue: (): Lines => [],
}) {}

/** Preserve unchanged repeated fields; native client edits take precedence field by field. */
export const reconcile = (lines: Lines, headers: Headers.Headers): Lines => {
  const original = new Map<string, Array<string>>();
  for (const [name, value] of lines) {
    const key = name.toLowerCase();
    original.set(key, [...(original.get(key) ?? []), value]);
  }
  return Object.entries(headers).flatMap(([key, value]): Array<readonly [string, string]> => {
    const values = original.get(key);
    return values?.join(", ") === value ? values.map((entry) => [key, entry]) : [[key, value]];
  });
};

/** Call inside a custom HttpClient provider, after its native request transformations. */
export const headerLines = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<Lines> =>
  Effect.map(HeaderLines, (lines) => reconcile(lines, request.headers));
