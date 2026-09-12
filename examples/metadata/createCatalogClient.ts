import { Effect, Schema } from "effect";
import { createApi, response, ResponseBody } from "../../src/main.js";
import { createdIdCodec } from "./createdIdCodec.js";
import {
  CatalogItem,
  CatalogQuery,
  CreatedCatalogItem,
  InvalidPageMetadata,
  NewCatalogItem,
  PageHeaders,
} from "./catalogSchemas.js";

/** Pure API-specific composition; the application supplies HttpClient when an operation runs. */
export const createCatalogClient = (baseUrl: string) => {
  const api = createApi(baseUrl);
  const list = api.createRequest({
    method: "GET",
    path: "/catalog",
    urlParamsSchema: CatalogQuery,
    responses: [
      response({ _tag: "listed", status: 200 }, Schema.Array(CatalogItem)),
      response({ _tag: "empty", status: 204 }, Schema.Void, { codec: ResponseBody.none }),
    ],
  });
  const create = api.createRequest({
    method: "POST",
    path: "/catalog",
    body: NewCatalogItem,
    responses: [response({ _tag: "created", status: 201 }, CreatedCatalogItem, { codec: createdIdCodec })],
  });
  return {
    list: (query: typeof CatalogQuery.Type) =>
      list()
        .setUrlParams(query)
        .effect.pipe(
          Effect.flatMap((envelope) =>
            Schema.decodeUnknown(PageHeaders)(envelope.headers).pipe(
              Effect.mapError(
                (cause) => new InvalidPageMetadata({ status: envelope.status, headers: envelope.headers, cause }),
              ),
              Effect.map((headers) => ({
                items: envelope._tag === "empty" ? [] : envelope.body,
                totalCount: headers["x-total-count"],
                response: envelope,
              })),
            ),
          ),
        ),
    create: (body: typeof NewCatalogItem.Type) => create().setBody(body).effect,
  };
};
