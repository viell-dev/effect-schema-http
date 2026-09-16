import { Context, Layer } from "effect";

export interface Service {
  readonly path: (value: string) => string;
  readonly query: (entries: ReadonlyArray<readonly [string, string]>) => string;
  readonly join: (base: string, path: string) => string;
}

/** No canonicalization: empty strings and dot segments survive this policy boundary. */
export const defaults: Service = {
  path: encodeURIComponent,
  query: (entries) =>
    entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&"),
  join: (base, path) =>
    !base || /^[a-z][a-z\d+.-]*:\/\//i.test(path)
      ? path
      : !path
        ? base
        : `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
};

export class Url extends Context.Reference<Url>()("viell-effect-schema-http/Url", { defaultValue: () => defaults }) {}
export const layer = (service: Service) => Layer.succeed(Url, service);
