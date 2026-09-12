import { Context, Layer } from "effect";
import type { QueryParamValue } from "../request/types.js";
import { encodeQueryParam } from "./encodeQueryParam.js";
import { joinUrl } from "./joinUrl.js";

/** Pure URL construction policies. No policy can override a downstream transport's capabilities. */
export class UrlEncoding extends Context.Tag("viell-effect-schema-http/UrlEncoding")<
  UrlEncoding,
  {
    readonly pathParameter: (value: string) => string;
    readonly queryParameter: (entry: readonly [string, QueryParamValue]) => string;
    readonly join: (baseUrl: string | undefined, path: string) => string;
  }
>() {
  /** Component encoding defaults; complete dot segments are neither rejected nor normalized here. */
  static readonly defaults: UrlEncoding["Type"] = {
    pathParameter: encodeURIComponent,
    queryParameter: encodeQueryParam,
    join: joinUrl,
  };

  /** Replaces selected policies while retaining the other defaults. */
  static layer(overrides: Partial<UrlEncoding["Type"]> = {}) {
    return Layer.succeed(UrlEncoding, { ...UrlEncoding.defaults, ...overrides });
  }

  static readonly Default = UrlEncoding.layer();
}
