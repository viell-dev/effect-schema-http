import { Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
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
import { configure, executionOptions, type Options } from "./options.js";
export const NOTIFY_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_NOTIFY_SERVER_URL) ||
  (typeof window === "undefined" ? "http://localhost:4500" : window.location.origin);

export const notifyRequest = (method: string, path: string, options: Options) =>
  Request.make(method, path).pipe(
    Request.baseUrl(NOTIFY_SERVER_URL),
    Request.setHeader("x-csrf-token", () => getCsrfToken()),
    configure(options),
  );

/** GET /session. */
export const notifySession = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/session", {}).pipe(Request.removeHeader("x-csrf-token"), configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(SessionToken), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** GET /notifications.json. */
export const listNotifications = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/notifications.json", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.text.pipe(Body.schema(XssiGuarded(Schema.Array(Notification))), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** GET /notifications.js. */
export const listNotificationsJsonp = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/notifications.js", {}).pipe(
      Request.setQuery("callback", "receiveNotifications"),
      configure(options),
    ),
    Response.when(
      (metadata) =>
        metadata.status === 200 &&
        ((value) => value?.startsWith("application/javascript") ?? false)(metadata.headers["content-type"]),
      Body.text.pipe(Body.schema(Jsonp("receiveNotifications", Schema.Array(Notification))), (decoder) =>
        Response.tag("ok", decoder),
      ),
    ),
    executionOptions(options),
  );

/** GET /inbox. */
export const getInbox = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/inbox", {}).pipe(configure(options)),
    Response.when(
      (metadata) =>
        metadata.status === 200 &&
        ((value) => value?.startsWith("text/html") ?? false)(metadata.headers["content-type"]),
      Body.text.pipe(Body.schema(JsonText(Inbox)), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** POST /notifications. */
export const createNotification = (options: Options = {}) =>
  Operation.make(
    notifyRequest("POST", "/notifications", {}).pipe(
      configure(options),
      Request.body(Body.jsonSchema(CreateNotification)),
    ),
    Response.status(
      201,
      Body.json.pipe(Body.schema(Notification), (decoder) => Response.tag("created", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          401,
          Body.json.pipe(Body.schema(SignatureRejected), (decoder) => Response.tag("SignatureRejected", decoder)),
        ),
      ),
      Response.orElse(
        Response.status(
          403,
          Body.json.pipe(Body.schema(CsrfRejected), (decoder) => Response.tag("CsrfRejected", decoder)),
        ),
      ),
      Response.orElse(
        Response.status(
          422,
          Body.json.pipe(Body.schema(PayloadRejected), (decoder) => Response.tag("PayloadRejected", decoder)),
        ),
      ),
    ),
    executionOptions(options),
  );

/** GET /notifications. */
export const listNotificationsUnmodelled = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/notifications", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Schema.Array(Notification)), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** GET /legacy/notifications. */
export const legacyNotifications = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/legacy/notifications", {}).pipe(configure(options)),
    Response.status(
      301,
      Body.json.pipe(Body.schema(Schema.Struct({ moved: Schema.String, since: Schema.String })), (decoder) =>
        Response.tag("moved", decoder),
      ),
    ).pipe(
      Response.orElse(
        Response.status(
          200,
          Body.text.pipe(Body.schema(XssiGuarded(Schema.Array(Notification))), (decoder) =>
            Response.tag("followed", decoder),
          ),
        ),
      ),
    ),
    executionOptions(options),
  );

/** GET /session/whoami. */
export const whoAmI = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/session/whoami", {}).pipe(Request.removeHeader("x-csrf-token"), configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(Schema.Struct({ token: Schema.String, valid: Schema.Boolean })), (decoder) =>
        Response.tag("ok", decoder),
      ),
    ).pipe(
      Response.orElse(
        Response.status(
          401,
          Body.json.pipe(Body.schema(Schema.Struct({ error: Schema.String, detail: Schema.String })), (decoder) =>
            Response.tag("noCookie", decoder),
          ),
        ),
      ),
    ),
    executionOptions(options),
  );

/** GET /notifications/poll. */
export const pollNotifications = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/notifications/poll", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(PollResult), (decoder) => Response.tag("ok", decoder)),
    ),
    executionOptions(options),
  );

/** GET /throttled. */
export const throttled = (options: Options = {}) =>
  Operation.make(
    notifyRequest("GET", "/throttled", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(ThrottleRelief), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          420,
          Body.json.pipe(Body.schema(EnhanceYourCalm), (decoder) => Response.tag("EnhanceYourCalm", decoder)),
        ),
      ),
    ),
    executionOptions(options),
  );
