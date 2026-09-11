/**
 * Worked pairings of every non-default body codec with a schema.
 *
 * Each codec consumes or produces one concrete transport value, and the schema paired with it is the one whose
 * encoded type (for requests) or decode input (for responses) already is that value. This file is typechecked, so
 * every pairing below is verified rather than described.
 */
import { Effect, ParseResult, Schema } from "effect";
import { createApi, RequestBody, response, ResponseBody, toEffect } from "../src/main.js";

const api = createApi("https://files.example.com");

/* Response: text ------------------------------------------------------------------------------------------------ */

/** `ResponseBody.text` decodes to `string`, so any schema whose encoded type is `string` fits. */
const getReadme = api.createRequest({
  method: "GET",
  path: "/documents/:documentId/readme",
  responses: [response({ _tag: "ok", status: 200 }, Schema.String, { codec: ResponseBody.text })],
});

/** A textual wire format stays a schema concern: pair the text codec with a `*FromString` transformation. */
class FeedEntry extends Schema.Class<FeedEntry>("FeedEntry")({
  title: Schema.String,
  link: Schema.String,
}) {}

const FeedFromString = Schema.transformOrFail(Schema.String, Schema.Array(FeedEntry), {
  strict: true,
  decode: (text, _options, ast) => {
    const entries = [...text.matchAll(/<entry><title>([^<]*)<\/title><link href="([^"]*)" \/><\/entry>/g)].map(
      ([, title, link]) => new FeedEntry({ title: title ?? "", link: link ?? "" }),
    );
    return entries.length === 0
      ? ParseResult.fail(new ParseResult.Type(ast, text, "no feed entries"))
      : ParseResult.succeed(entries);
  },
  encode: (entries) =>
    ParseResult.succeed(
      entries.map(({ title, link }) => `<entry><title>${title}</title><link href="${link}" /></entry>`).join(""),
    ),
});

/**
 * A rule-specific codec never changes the request's `Accept` header, because rules are selected after the response
 * arrives. Declare the header explicitly when the endpoint negotiates a non-JSON representation.
 */
const getFeed = api.createRequest({
  method: "GET",
  path: "/blogs/:blogId/feed.atom",
  headers: { accept: "application/atom+xml" },
  responses: [response({ _tag: "ok", status: 200 }, FeedFromString, { codec: ResponseBody.text })],
});

/* Response: bytes ----------------------------------------------------------------------------------------------- */

/** `ResponseBody.uint8Array` decodes to `Uint8Array`; `Schema.Uint8ArrayFromSelf` passes those bytes through. */
const downloadAttachment = api.createRequest({
  method: "GET",
  path: "/attachments/:attachmentId",
  responses: [response({ _tag: "ok", status: 200 }, Schema.Uint8ArrayFromSelf, { codec: ResponseBody.uint8Array })],
});

/** When the bytes are themselves a structured payload, decode them with a transformation from the same input type. */
const StatsFromBytes = Schema.transformOrFail(
  Schema.Uint8ArrayFromSelf,
  Schema.Struct({ posts: Schema.Number, users: Schema.Number }),
  {
    strict: true,
    decode: (bytes, _options, ast) =>
      ParseResult.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as { posts: number; users: number },
        catch: () => new ParseResult.Type(ast, bytes, "malformed statistics payload"),
      }),
    encode: (stats) => ParseResult.succeed(new TextEncoder().encode(JSON.stringify(stats))),
  },
);

const getStats = api.createRequest({
  method: "GET",
  path: "/admin/stats",
  responses: [response({ _tag: "ok", status: 200 }, StatsFromBytes, { codec: ResponseBody.uint8Array })],
});

/* Response: form data and no body ------------------------------------------------------------------------------- */

/** `ResponseBody.formData` decodes to `FormData`; `Schema.instanceOf` is the identity schema for it. */
const FormDataFromSelf = Schema.instanceOf(FormData);

const getUploadTicket = api.createRequest({
  method: "GET",
  path: "/uploads/:uploadId/ticket",
  responses: [response({ _tag: "ok", status: 200 }, FormDataFromSelf, { codec: ResponseBody.formData })],
});

/**
 * `ResponseBody.none` drains the payload and decodes `undefined`, so its schema must accept `undefined` as its
 * encoded type. `Schema.Void` is the usual choice, and the status can be any bodyless status, not only `204`.
 */
const refreshCache = api.createRequest({
  method: "POST",
  path: "/admin/cache/refresh",
  responses: [
    response({ _tag: "reset", status: 205 }, Schema.Void, { codec: ResponseBody.none }),
    response({ _tag: "accepted", status: 202 }, Schema.Void, { codec: ResponseBody.none }),
  ],
});

/* Requests ------------------------------------------------------------------------------------------------------ */

/** `RequestBody.formData` takes `FormData`; the caller passes a real `FormData` through the identity schema. */
const uploadAttachment = api.createRequest({
  method: "POST",
  path: "/posts/:postId/attachments",
  body: FormDataFromSelf,
  bodyCodec: RequestBody.formData,
  responses: [response({ _tag: "created", status: 201 }, Schema.Struct({ id: Schema.String }))],
});

/** `RequestBody.text` takes `string`, so the request schema is one whose *encoded* type is `string`. */
const publishFeed = api.createRequest({
  method: "PUT",
  path: "/blogs/:blogId/feed.atom",
  body: FeedFromString,
  bodyCodec: RequestBody.text("application/atom+xml"),
  responses: [response({ _tag: "ok", status: 200 }, Schema.Void, { codec: ResponseBody.none })],
});

/** `RequestBody.uint8Array` takes `Uint8Array`; the same transformation encodes a domain value back to bytes. */
const putStats = api.createRequest({
  method: "PUT",
  path: "/admin/stats",
  body: StatsFromBytes,
  bodyCodec: RequestBody.uint8Array("application/json"),
  responses: [response({ _tag: "ok", status: 200 }, Schema.Void, { codec: ResponseBody.none })],
});

/** `RequestBody.urlParams` takes a record of coercible values, which a struct of strings already satisfies. */
const requestToken = api.createRequest({
  method: "POST",
  path: "/oauth/token",
  body: Schema.Struct({ grant_type: Schema.Literal("password"), username: Schema.String, password: Schema.String }),
  bodyCodec: RequestBody.urlParams,
  responses: [response({ _tag: "ok", status: 200 }, Schema.Struct({ access_token: Schema.String }))],
});

/** Every pairing above stays an ordinary plan; nothing here executes until its Effect is provided a client. */
export const program = Effect.all([
  getReadme({ documentId: "doc-1" }).pipe(toEffect),
  getFeed({ blogId: "ada" }).pipe(toEffect),
  downloadAttachment({ attachmentId: "file-1" }).pipe(toEffect),
  getStats().pipe(toEffect),
  getUploadTicket({ uploadId: "upload-1" }).pipe(toEffect),
  refreshCache().pipe(toEffect),
  uploadAttachment({ postId: "post-1" }).setBody(new FormData()).pipe(toEffect),
  publishFeed({ blogId: "ada" })
    .setBody([new FeedEntry({ title: "Hello", link: "https://example.com/hello" })])
    .pipe(toEffect),
  putStats().setBody({ posts: 2, users: 1 }).pipe(toEffect),
  requestToken().setBody({ grant_type: "password", username: "ada", password: "secret" }).pipe(toEffect),
]);
