import { ConfigProvider, Layer } from "effect";

/** Vite config in the browser, ordinary environment config in Node. */
const provider =
  import.meta.env === undefined
    ? ConfigProvider.fromEnv()
    : ConfigProvider.fromMap(
        new Map(
          Object.entries(import.meta.env)
            .filter(([, value]) => typeof value === "string" || typeof value === "boolean")
            .map(([key, value]) => [key, String(value)] as const),
        ),
        { pathDelim: "_" },
      ).pipe(ConfigProvider.nested("VITE"), ConfigProvider.constantCase);

export const ConfigProviderLive = Layer.setConfigProvider(provider);
