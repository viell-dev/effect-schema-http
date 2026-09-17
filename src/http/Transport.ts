import { Headers, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Context, Effect, Option } from "effect";

export type Lines = ReadonlyArray<readonly [string, string]>;

/** The same materialized field shapes accepted by Platform, without discarding repeated pairs. */
export type HeaderInput = Headers.Input;

export const entries = (input: HeaderInput): Lines =>
  Symbol.iterator in input
    ? Array.from(input, ([name, value]) => [name, value] as const)
    : Object.entries(input).flatMap(([name, value]): Array<readonly [string, string]> =>
        value === undefined ? [] : typeof value === "string" ? [[name, value]] : value.map((entry) => [name, entry]),
      );

/** A normalized compatibility view for native HttpClient middleware; lines remain authoritative. */
export const toHeaders = (lines: Lines): Headers.Headers => {
  const grouped = new Map<string, Array<string>>();
  for (const [name, value] of lines) {
    const key = name.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return Headers.fromInput([...grouped].map(([key, values]) => [key, values.join(", ")] as const));
};

/** Per-evaluation wire details for providers that support repeated physical header lines. */
export class HeaderLines extends Context.Reference<HeaderLines>()("viell-effect-schema-http/Transport/HeaderLines", {
  defaultValue: (): Lines => [],
}) {}

/** Preserve original order and values for unchanged fields; native edits win field by field. */
export const reconcile = (lines: Lines, headers: Headers.Headers): Lines => {
  const original = toHeaders(lines);
  const preserved = new Set(Object.keys(original).filter((name) => original[name] === headers[name]));
  return [
    ...lines.filter(([name]) => preserved.has(name.toLowerCase())),
    ...Object.entries(headers).filter(([name]) => !preserved.has(name)),
  ];
};

/** Call inside a custom HttpClient provider, after its native request transformations. */
export const headerLines = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<Lines> =>
  Effect.map(HeaderLines, (lines) => reconcile(lines, request.headers));

export const ResponseHeaderLines: unique symbol = Symbol.for("viell-effect-schema-http/Transport/ResponseHeaderLines");

/** Provider hook. Snapshot observed lines before its native adapter normalizes them. */
export const withResponseHeaders = (
  response: HttpClientResponse.HttpClientResponse,
  lines: Lines,
): HttpClientResponse.HttpClientResponse => {
  Object.defineProperty(response, ResponseHeaderLines, {
    value: lines.map(([name, value]) => [name, value] as const),
    configurable: true,
  });
  return response;
};

/** None means the provider did not supply lines. Never split or reconstruct normalized values. */
export const responseHeaderLines = (response: HttpClientResponse.HttpClientResponse): Option.Option<Lines> =>
  ResponseHeaderLines in response
    ? Option.some(
        (response as HttpClientResponse.HttpClientResponse & { readonly [ResponseHeaderLines]: Lines })[
          ResponseHeaderLines
        ],
      )
    : Option.none();
