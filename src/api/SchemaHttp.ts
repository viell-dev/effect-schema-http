import { Context, Effect, Layer } from "effect";
import { UrlEncoding } from "../encoding/UrlEncoding.js";
import type { AnyResponseRule, Api, ApiOptions, RequestOptions } from "../request/types.js";
import { createApi } from "./createApi.js";
import { createRequest } from "./createRequest.js";

/** Library construction service. Execution continues to use the consumer's HttpClient, Logger, and schema services. */
export class SchemaHttp extends Context.Tag("viell-effect-schema-http/SchemaHttp")<
  SchemaHttp,
  {
    readonly createApi: typeof createApi;
    readonly createRequest: typeof createRequest;
  }
>() {
  /** Builds a service with library-wide defaults and a consumer-supplied URL policy. */
  static layer(defaults: RequestOptions = {}) {
    return Layer.effect(
      SchemaHttp,
      Effect.gen(function* () {
        const encoding = yield* UrlEncoding;
        const options = { urlEncoding: encoding, ...defaults };
        return SchemaHttp.of({
          createApi: <const Rules extends ReadonlyArray<AnyResponseRule> = readonly []>(
            baseUrl: string,
            overrides: ApiOptions<Rules> = {} as ApiOptions<Rules>,
          ): Api<Rules> => createApi(baseUrl, options).extend(overrides) as Api<Rules>,
          createRequest: (definition, overrides = {}) => createRequest(definition, { ...options, ...overrides }),
        });
      }),
    );
  }

  /** Ready-to-compose defaults. Use layer(...) with a replacement UrlEncoding layer to customize construction. */
  static readonly Default = SchemaHttp.layer().pipe(Layer.provide(UrlEncoding.Default));
}
