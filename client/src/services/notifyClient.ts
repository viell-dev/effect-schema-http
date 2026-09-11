import { Schema } from "effect";
import { createApi, response, ResponseBody } from "viell-effect-schema-http";
import {
  CreateNotification,
  CsrfRejected,
  EnhanceYourCalm,
  Inbox,
  Jsonp,
  JsonText,
  Notification,
  PayloadRejected,
  PollResult,
  SessionToken,
  SignatureRejected,
  ThrottleRelief,
  XssiGuarded,
} from "../schemas/notifyService.js";
import { getCsrfToken } from "../session.js";

export const NOTIFY_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_NOTIFY_SERVER_URL) || "http://localhost:4500";

/**
 * The 2011 notification service.
 *
 * Its credential is a CSRF token that has to be fetched first and echoed in a header, so
 * the API-wide declaration is one computed header. The *signature* cannot be declared
 * here at all — see `plans/signing.ts` for why — and is applied per call site with the
 * `signed` transform.
 */
export const notifyApi = createApi(NOTIFY_SERVER_URL, {
  headers: {
    "x-csrf-token": () => getCsrfToken(),
  },
});

/**
 * `GET /session` — the token, two cookies, and three ways of saying "stop using this".
 *
 * The rule reads nothing special; everything interesting is on the envelope, which
 * carries the parsed cookies and the raw header entries alongside the decoded body.
 */
export const notifySession = notifyApi.createRequest({
  method: "GET",
  path: "/session",
  removeHeaders: ["x-csrf-token"],
  responses: [response({ _tag: "ok", status: 200 }, SessionToken)],
});

/**
 * `GET /notifications.json` — JSON behind an anti-hijacking guard.
 *
 * The content type says `application/json` and the payload is not JSON, so the default
 * codec fails on the first byte. Reading it as text and stripping the guard in the
 * schema is the whole fix.
 */
export const listNotifications = notifyApi.createRequest({
  method: "GET",
  path: "/notifications.json",
  responses: [
    response({ _tag: "ok", status: 200 }, XssiGuarded(Schema.Array(Notification)), { codec: ResponseBody.text }),
  ],
});

/** `GET /notifications.js` — the same data as a JavaScript program, for a partner. */
export const listNotificationsJsonp = notifyApi.createRequest({
  method: "GET",
  path: "/notifications.js",
  urlParams: { callback: "receiveNotifications" },
  responses: [
    response(
      {
        _tag: "ok",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("application/javascript") ?? false },
      },
      Jsonp("receiveNotifications", Schema.Array(Notification)),
      { codec: ResponseBody.text },
    ),
  ],
});

/**
 * `GET /inbox` — JSON served as `text/html`.
 *
 * The header matcher is what makes this honest: the rule says "this is the case where
 * the service claims HTML", and the codec and schema together say "and it is really
 * JSON". A reader of the declaration can see both facts.
 */
export const getInbox = notifyApi.createRequest({
  method: "GET",
  path: "/inbox",
  responses: [
    response(
      {
        _tag: "ok",
        status: 200,
        headers: { "content-type": (value) => value?.startsWith("text/html") ?? false },
      },
      JsonText(Inbox),
      { codec: ResponseBody.text },
    ),
  ],
});

/**
 * `POST /notifications` — signed and CSRF-guarded.
 *
 * Apply the `signed` transform at the call site. Every rejection is a declared rule, so
 * "the signature was stale", "the token was wrong" and "the payload was empty" are three
 * distinguishable values rather than one thrown error with a status buried in it.
 */
export const createNotification = notifyApi.createRequest({
  method: "POST",
  path: "/notifications",
  body: CreateNotification,
  responses: [
    response({ _tag: "created", status: 201 }, Notification),
    response({ _tag: "SignatureRejected", status: 401 }, SignatureRejected),
    response({ _tag: "CsrfRejected", status: 403 }, CsrfRejected),
    response({ _tag: "PayloadRejected", status: 422 }, PayloadRejected),
  ],
});

/** `GET /notifications/poll` — holds the connection open, which is the point. */
export const pollNotifications = notifyApi.createRequest({
  method: "GET",
  path: "/notifications/poll",
  responses: [response({ _tag: "ok", status: 200 }, PollResult)],
});

/**
 * `GET /throttled` — `420 Enhance Your Calm`.
 *
 * Twitter used `420` before `429` was standardized and this service copied it. It is not
 * registered, so the library's built-in transient set does not include it and never
 * should — `while` is the documented way to *add* a retryable case, and this is exactly
 * what that is for.
 */
export const throttled = notifyApi.createRequest({
  method: "GET",
  path: "/throttled",
  responses: [
    response({ _tag: "ok", status: 200 }, ThrottleRelief),
    response({ _tag: "EnhanceYourCalm", status: 420 }, EnhanceYourCalm),
  ],
});
