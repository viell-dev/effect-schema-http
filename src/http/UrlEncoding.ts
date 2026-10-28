import { Context, Layer } from "effect";

/** Ordered query entries. `null` is a bare key (`?wsdl`); an empty string is an empty value (`?wsdl=`). */
export type Query = ReadonlyArray<readonly [string, string | null]>;

/** A scalar query value. `null` is a bare key and `undefined` omits the entry. */
export type QueryValue = string | number | bigint | boolean | null | undefined;

/** The encoded shapes a query schema may produce: a record or ordered pairs, with scalar or array values. */
export type QueryInput =
  | Readonly<Record<string, QueryValue | ReadonlyArray<QueryValue>>>
  | Iterable<readonly [string, QueryValue | ReadonlyArray<QueryValue>]>;

/** Expand a query collection into ordered entries, preserving repetition. */
export const queryEntries = (input: QueryInput): Query => {
  const entries =
    Symbol.iterator in input ? Array.from(input) : Object.entries(input);
  return entries.flatMap(
    ([key, value]): Array<readonly [string, string | null]> =>
      (Array.isArray(value) ? value : [value]).flatMap((entry: QueryValue) =>
        entry === undefined
          ? []
          : [[key, entry === null ? null : String(entry)] as const],
      ),
  );
};

/** The policy that renders path values, query entries, and the final URL. */
export interface Service {
  readonly path: (value: string) => string;
  readonly query: (entries: Query) => string;
  readonly join: (base: string, path: string) => string;
}

const absolute = /^[a-z][a-z\d+.-]*:\/\//i;

/** Percent-encode without canonicalizing: empty strings and dot segments survive this policy boundary. */
export const defaults: Service = {
  path: encodeURIComponent,
  query: (entries) =>
    entries
      .map(([key, value]) =>
        value === null
          ? encodeURIComponent(key)
          : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&"),
  join: (base, path) => {
    if (base === "" || absolute.test(path)) return path;
    if (path === "") return base;
    return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  },
};

/** The URL encoding used during request materialization. Defaults to {@link defaults}. */
export const UrlEncoding: Context.Reference<Service> =
  Context.Reference<Service>("viell-effect-schema-http/UrlEncoding", {
    defaultValue: () => defaults,
  });

/** Replace the URL encoding through ordinary Layer composition. */
export const layer = (service: Service): Layer.Layer<never> =>
  Layer.succeed(UrlEncoding, service);
