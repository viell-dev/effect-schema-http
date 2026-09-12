import { type AnyResponseRule, type Api, type ApiExtensionOptions, type MergeResponseRules } from "../request/types.js";

/** Pipeable form of {@link Api.extend}. */
export const extendApi =
  <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(options: ApiExtensionOptions<Overrides>) =>
  <Defaults extends ReadonlyArray<AnyResponseRule>>(api: Api<Defaults>): Api<MergeResponseRules<Defaults, Overrides>> =>
    api.extend(options);
