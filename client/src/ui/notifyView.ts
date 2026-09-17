import { Cause, DateTime, Effect, Schedule, Schema } from "effect";
import { Policy, Request } from "viell-effect-schema-http";
import { h } from "../dom.js";
import { signed } from "../plans/signing.js";
import { run } from "../runtime.js";
import { RetirementNotice } from "../schemas/notifyService.js";
import {
  createNotification,
  getInbox,
  listNotifications,
  listNotificationsJsonp,
  notifySession,
  pollNotifications,
  throttled,
} from "../services/notifyClient.js";
import { setCsrfToken } from "../session.js";
import { actionPanel, field, show, type Action } from "./panel.js";

/** Every call in this view goes to the Ruby notification service on :4500. */
export const renderNotifyView = (): HTMLElement => {
  const message = field("message", "The reconciliation finished");

  const actions: ReadonlyArray<Action> = [
    {
      label: "Open a session",
      note: "A CSRF token in the body, two cookies, and three different ways of saying “stop using this”.",
      run: async () => {
        const result = await run(notifySession().execute(undefined));
        if (result._tag !== "ok") return show(result);
        setCsrfToken(result.value.csrf_token);
        const notice = Schema.decodeUnknownSync(RetirementNotice)(result.metadata.headers);
        return [
          `csrf token ${result.value.csrf_token}`,
          `cookies: ${Object.keys(result.metadata.cookies.cookies).join(", ")}`,
          "",
          `Deprecation: ${notice.deprecation}`,
          `Sunset:      ${DateTime.formatIso(notice.sunset)}`,
          `Warning:     ${notice.warning}`,
          "",
          "Three headers, three drafts, one meaning. A client that wants to warn an operator has to read all three.",
        ].join("\n");
      },
    },
    {
      label: "List (behind an XSSI guard)",
      note: "The content type says JSON and the payload is not JSON until five bytes come off.",
      run: async () => {
        const result = await run(listNotifications().execute(undefined));
        if (result._tag !== "ok") return show(result);
        return [
          `content-type: ${result.metadata.headers["content-type"]}`,
          "",
          ...result.value.map((item) => `${item.id}  ${item.kind.padEnd(11)} ${item.text}`),
        ].join("\n");
      },
    },
    {
      label: "List (JSONP)",
      note: "A JavaScript program, read as data by knowing exactly which wrapper to expect.",
      run: async () => {
        const result = await run(listNotificationsJsonp().execute(undefined));
        return result._tag === "ok" ? result.value.map((item) => `${item.id}  ${item.text}`).join("\n") : show(result);
      },
    },
    {
      label: "Read the inbox (JSON as text/html)",
      note: "A 2012 template whose contents were replaced with a JSON literal and nothing else.",
      run: async () => {
        const result = await run(getInbox().execute(undefined));
        return result._tag === "ok"
          ? `content-type: ${result.metadata.headers["content-type"]}\n\n${show(result.value)}`
          : show(result);
      },
    },
    {
      label: "Post one (signed)",
      note: "HMAC over the encoded body, from mapClient, because a computed header cannot see it.",
      run: async () => {
        const result = await run(
          createNotification({ transformClient: signed }).execute({
            body: { kind: "note", text: message.input.value },
          }),
        );
        return result._tag === "created"
          ? `created ${result.value.id}\nLocation: ${result.metadata.headers.location}`
          : `${result._tag}: ${show(result.value)}`;
      },
    },
    {
      label: "Post one (unsigned)",
      note: "The same plan without the transform. A typed 401, not a thrown error.",
      run: async () => {
        const result = await run(createNotification().execute({ body: { kind: "note", text: message.input.value } }));
        return `${result._tag} (${result.metadata.status}): ${show(result.value)}`;
      },
    },
    {
      label: "Hit the throttle (no retry)",
      note: "420 Enhance Your Calm is not registered and is correctly not in the transient set.",
      run: async () => {
        const client = `web-${Date.now()}`;
        const result = await run(
          throttled({
            request: (request) => request.pipe(Request.setHeader("x-client-id", client)),
            policy: Policy.make(Schedule.recurs(3)),
          }).execute(undefined),
        );
        return `${result._tag} (${result.metadata.status}) after three built-in retries changed nothing`;
      },
    },
    {
      label: "Hit the throttle (retry.while)",
      note: "`while` adds a retryable case; it cannot veto the built-in ones. This is what it is for.",
      run: async () => {
        const client = `web-${Date.now()}`;
        const result = await run(
          throttled({
            request: (request) => request.pipe(Request.setHeader("x-client-id", client)),
            policy: Policy.make(Schedule.recurs(4), {
              while: (reason) => Policy.transient(reason) || reason.metadata?.status === 420,
            }),
          }).execute(undefined),
        );
        return result._tag === "ok"
          ? `succeeded after ${result.value.attempts} server-side attempts; the handler only saw the last one`
          : `${result._tag}: ${show(result.value)}`;
      },
    },
    {
      label: "Long poll, then time it out",
      note: "setTimeout bounds one attempt; a timeout is an Effect failure, not a mapped response.",
      run: async () => {
        const quick = await run(
          pollNotifications({ request: (request) => request.pipe(Request.setQuery("wait", "1")) }).execute(undefined),
        );
        const lines = [`waited ${quick._tag === "ok" ? quick.value.waited : "?"}s and returned normally`];
        try {
          await run(
            pollNotifications({ request: (request) => request.pipe(Request.setQuery("wait", "5")) })
              .execute(undefined)
              .pipe(Effect.timeout("400 millis")),
          );
          lines.push("the five-second poll unexpectedly returned");
        } catch (error) {
          const cause = error instanceof Error ? (error as { readonly cause?: unknown }).cause : undefined;
          lines.push(
            Cause.isTimeoutException(cause) || String(error).includes("Timeout")
              ? "the five-second poll was cut off by setTimeout, as a TimeoutException"
              : `the five-second poll failed with ${String(error)}`,
          );
        }
        return lines.join("\n");
      },
    },
  ];

  return h(
    "div",
    {},
    h("div", { class: "fields" }, message.row),
    actionPanel(
      "Ruby notification service, :4500",
      "Signed requests, a double-submitted CSRF token, JSONP, an anti-hijacking guard that outlived the attack, and a status code that was never registered.",
      actions,
    ),
  );
};
