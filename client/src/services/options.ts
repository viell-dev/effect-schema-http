import { HttpClient } from "@effect/platform";
import { Request, type Operation } from "viell-effect-schema-http";

/** Application choices shared by the five service clients. Schema bindings are applied afterwards. */
export interface Options extends Operation.Options {
  readonly request?: (request: Request.Request<unknown>) => Request.Request<unknown>;
}

export const configure = (options: Options) => (request: Request.Request<unknown>) =>
  options.request?.(request) ?? request;

export const executionOptions = (
  options: Options,
  defaults: (client: HttpClient.HttpClient) => HttpClient.HttpClient = (client) => client,
): Operation.Options => ({
  ...(options.policy === undefined ? {} : { policy: options.policy }),
  transformClient: (client) => options.transformClient?.(defaults(client)) ?? defaults(client),
});
