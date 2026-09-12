import { FetchHttpClient } from "@effect/platform";
import { Config, Effect, Layer, Logger, LogLevel, ManagedRuntime } from "effect";
import { ConfigProviderLive } from "./ConfigProviderLive.js";
import { SchemaHttp } from "viell-effect-schema-http";

/** Application-owned construction, transport and logging defaults for browser and Node execution. */
export const LoggerLive = Layer.merge(
  Logger.pretty,
  Config.logLevel("LOG_LEVEL").pipe(
    Config.withDefault(LogLevel.Error),
    Effect.map(Logger.minimumLogLevel),
    Layer.unwrapEffect,
  ),
);

export const DefaultLive = Layer.mergeAll(
  SchemaHttp.Default,
  FetchHttpClient.layer,
  LoggerLive.pipe(Layer.provideMerge(ConfigProviderLive)),
);
export const defaultRuntime = ManagedRuntime.make(DefaultLive);

// All layers here initialize synchronously. Asynchronous application resources would require
// awaiting runPromise during application startup instead.
export const schemaHttp = defaultRuntime.runSync(
  Effect.gen(function* () {
    return yield* SchemaHttp;
  }),
);
export const run = defaultRuntime.runPromise.bind(defaultRuntime);
export const runFork = defaultRuntime.runFork.bind(defaultRuntime);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) void defaultRuntime.dispose();
  });
}
