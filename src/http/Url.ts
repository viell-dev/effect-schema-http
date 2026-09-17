import { Context, Layer } from "effect";

export type Query = ReadonlyArray<readonly [string, string | null]>;
export type QueryValue = string | number | boolean | null | undefined;
export type QueryInput =
  | Readonly<Record<string, QueryValue | ReadonlyArray<QueryValue>>>
  | Iterable<readonly [string, QueryValue | ReadonlyArray<QueryValue>]>;

export const queryEntries = (input: QueryInput): Query => {
  const entries = Symbol.iterator in input ? Array.from(input) : Object.entries(input);
  return entries.flatMap(([key, value]): Array<readonly [string, string | null]> =>
    (Array.isArray(value) ? value : [value]).flatMap((entry) =>
      entry === undefined ? [] : [[key, entry === null ? null : String(entry)] as const],
    ),
  );
};

export interface Service {
  readonly path: (value: string) => string;
  readonly query: (entries: Query) => string;
  readonly join: (base: string, path: string) => string;
}

/** No canonicalization: empty strings and dot segments survive this policy boundary. */
export const defaults: Service = {
  path: encodeURIComponent,
  query: (entries) =>
    entries
      .map(([key, value]) =>
        value === null ? encodeURIComponent(key) : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&"),
  join: (base, path) =>
    !base || /^[a-z][a-z\d+.-]*:\/\//i.test(path)
      ? path
      : !path
        ? base
        : `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
};

export class Url extends Context.Reference<Url>()("viell-effect-schema-http/Url", { defaultValue: () => defaults }) {}
export const layer = (service: Service) => Layer.succeed(Url, service);
