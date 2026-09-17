import { FetchHttpClient } from "@effect/platform";
import { Config, Effect, Layer, Logger, LogLevel, ManagedRuntime } from "effect";
import { ConfigProviderLive } from "./ConfigProviderLive.js";

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
  FetchHttpClient.layer,
  LoggerLive.pipe(Layer.provideMerge(ConfigProviderLive)),
);
export const defaultRuntime = ManagedRuntime.make(DefaultLive);

export const run = defaultRuntime.runPromise.bind(defaultRuntime);
export const runFork = defaultRuntime.runFork.bind(defaultRuntime);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) void defaultRuntime.dispose();
  });
}
