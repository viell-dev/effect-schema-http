import { Context, Effect, Option } from "effect";
import {
  Headers,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/** Physical header lines in order, with their original spelling and repetition. */
export type Lines = ReadonlyArray<readonly [string, string]>;

/** The header collections accepted by `effect/http`, expanded here without combining repeated values. */
export type HeaderInput = Headers.Input;

/** Expand a header collection into ordered lines. Array values become repeated lines. */
export const entries = (input: HeaderInput): Lines =>
  Symbol.iterator in input
    ? Array.from(input, ([name, value]) => [name, value] as const)
    : Object.entries(input).flatMap(
        ([name, value]): Array<readonly [string, string]> =>
          value === undefined
            ? []
            : typeof value === "string"
              ? [[name, value]]
              : value.map((line) => [name, line]),
      );

/** The normalized view used by native middleware: lowercase names, repeated values joined with `, `. */
export const toHeaders = (lines: Lines): Headers.Headers => {
  const grouped = new Map<string, Array<string>>();
  for (const [name, value] of lines) {
    const key = name.toLowerCase();
    const values = grouped.get(key);
    if (values === undefined) grouped.set(key, [value]);
    else values.push(value);
  }
  return Headers.fromInput(
    Array.from(grouped, ([key, values]) => [key, values.join(", ")] as const),
  );
};

/**
 * Keep the original lines of every field whose normalized value is unchanged; changed or added native
 * fields replace them field by field.
 */
export const reconcile = (lines: Lines, headers: Headers.Headers): Lines => {
  const original = toHeaders(lines);
  const preserved = new Set(
    Object.keys(original).filter((name) => original[name] === headers[name]),
  );
  return [
    ...lines.filter(([name]) => preserved.has(name.toLowerCase())),
    ...Object.entries(headers).filter(([name]) => !preserved.has(name)),
  ];
};

/** The request header lines of the current operation evaluation. Operations provide it to each attempt. */
export const HeaderLines: Context.Reference<Lines> = Context.Reference<Lines>(
  "viell-effect-schema-http/Transport/HeaderLines",
  { defaultValue: () => [] },
);

/** For custom HttpClient providers: the lines to send, reconciled with the request after native middleware. */
export const headerLines = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Lines> =>
  Effect.map(HeaderLines, (lines) => reconcile(lines, request.headers));

const ResponseHeaderLines = Symbol.for(
  "viell-effect-schema-http/Transport/ResponseHeaderLines",
);

/**
 * For custom HttpClient providers: attach a snapshot of the observed response lines before returning the
 * response. Native headers are unchanged.
 */
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

/** The provider-attached response lines. `None` means none were supplied; normalized values are never split. */
export const responseHeaderLines = (
  response: HttpClientResponse.HttpClientResponse,
): Option.Option<Lines> =>
  Option.fromUndefinedOr(
    (response as { readonly [ResponseHeaderLines]?: Lines })[
      ResponseHeaderLines
    ],
  );
