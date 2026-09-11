/**
 * The calendar page: one list, three shapes, rendered exhaustively.
 *
 * This is the page that shows what a `Schema.Union` body is *for*. `Match.tag` over each entry is
 * exhaustive, so adding a fourth kind of calendar entry to the domain schema would fail to compile
 * here until this file decided how to draw it — which is the property a flattened struct full of
 * optional fields would silently throw away.
 *
 * Note that each branch reads fields the others do not have: an assignment has a customer and an
 * address, a repeating event has a recurrence rule, a single event has neither. None of that needs
 * a null check, because the shape that reached the branch is the shape that has them.
 */
import { DateTime, Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import {
  CreateEventInput,
  CreateServiceOrderInput,
  type CalendarEntry,
  type Recurrence,
} from "@realworld/domain";
import { h, mount } from "../dom.js";
import { renderNav } from "../components/nav.js";
import { createCalendarEvent, createServiceOrder, listCalendar } from "../api.js";
import { run } from "../runtime.js";
import { decodeForm } from "../decodeForm.js";
import { domainErrorMessage } from "../errors.js";
import { getSession } from "../session.js";
import { navigate } from "../router.js";

const at = (value: DateTime.Utc): string => new Date(DateTime.toEpochMillis(value)).toLocaleString();

const describeRecurrence = (recurrence: Recurrence): string => {
  const every = recurrence.interval === 1 ? "" : `every ${recurrence.interval} `;
  const unit = { daily: "day", weekly: "week", monthly: "month" }[recurrence.frequency];
  const suffix = recurrence.until ? `, until ${at(recurrence.until)}` : "";
  return `repeats ${every}${unit}${recurrence.interval === 1 ? "ly" : "s"}${suffix}`;
};

/** One renderer per shape. Exhaustive: a new member of the union breaks this at compile time. */
const renderEntry = (entry: CalendarEntry): HTMLElement =>
  Match.value(entry).pipe(
    Match.tag("event", (event) =>
      h(
        "article",
        { class: "calendar-entry" },
        h("span", { class: "badge badge-public" }, "event"),
        h("strong", {}, event.title),
        h("p", { class: "post-meta" }, `${at(event.startsAt)} – ${at(event.endsAt)}`),
      ),
    ),
    Match.tag("repeating", (event) =>
      h(
        "article",
        { class: "calendar-entry" },
        h("span", { class: "badge badge-draft" }, "repeating"),
        h("strong", {}, event.title),
        h("p", { class: "post-meta" }, `${at(event.startsAt)} – ${at(event.endsAt)}`),
        h("p", { class: "hint" }, describeRecurrence(event.recurrence)),
      ),
    ),
    Match.tag("assignment", (assignment) =>
      h(
        "article",
        { class: "calendar-entry" },
        h("span", { class: "badge badge-private" }, `assignment · ${assignment.status}`),
        h("strong", {}, assignment.title),
        h("p", { class: "post-meta" }, at(assignment.scheduledFor)),
        // Fields only this member has, reached without a single null check.
        h("p", { class: "hint" }, `${assignment.customer} — ${assignment.address}`),
      ),
    ),
    Match.exhaustive,
  );

export const renderCalendarPage = async (root: HTMLElement): Promise<void> => {
  const session = getSession();
  if (!session) {
    navigate("/login");
    return;
  }

  const main = h("main", { class: "container" }, h("p", {}, "Loading calendar…"));
  mount(root, renderNav(), main);

  const result = await run(listCalendar().pipe(toEffect)).catch((error: unknown) => {
    console.error("calendar request failed", error);
    return undefined;
  });

  if (!result) {
    mount(main, h("p", { class: "error" }, "Could not reach the server. Is it running?"));
    return;
  }

  const errorMessage = domainErrorMessage(result);
  if (errorMessage) {
    mount(main, h("p", { class: "error" }, errorMessage));
    return;
  }

  const rerender = () => void renderCalendarPage(root);

  const eventError = h("p", { class: "error hidden" });
  const titleInput = h("input", { type: "text", name: "title", required: "true" });
  const startInput = h("input", { type: "datetime-local", name: "startsAt", required: "true" });
  const endInput = h("input", { type: "datetime-local", name: "endsAt", required: "true" });
  const repeatSelect = h(
    "select",
    { name: "frequency" },
    h("option", { value: "" }, "does not repeat"),
    h("option", { value: "daily" }, "daily"),
    h("option", { value: "weekly" }, "weekly"),
    h("option", { value: "monthly" }, "monthly"),
  );

  const localToIso = (value: string): string => (value === "" ? "" : new Date(value).toISOString());

  const eventForm = h(
    "form",
    {
      class: "card form",
      onsubmit: (event: Event) => {
        event.preventDefault();
        eventError.classList.add("hidden");

        const decoded = decodeForm(CreateEventInput, {
          title: titleInput.value,
          startsAt: localToIso(startInput.value),
          endsAt: localToIso(endInput.value),
          // Supplying a recurrence is what makes the server store the other shape.
          recurrence: repeatSelect.value === "" ? undefined : { frequency: repeatSelect.value, interval: 1 },
        });
        if (decoded._tag === "failure") {
          eventError.textContent = decoded.issues.join("; ");
          eventError.classList.remove("hidden");
          return;
        }

        void run(createCalendarEvent().setBody(decoded.value).pipe(toEffect))
          .then((created) => {
            const message = domainErrorMessage(created);
            if (message) {
              eventError.textContent = message;
              eventError.classList.remove("hidden");
              return;
            }
            rerender();
          })
          .catch((error: unknown) => {
            console.error("calendar event creation failed", error);
            eventError.textContent = "Could not reach the server. Is it running?";
            eventError.classList.remove("hidden");
          });
      },
    },
    h("h2", {}, "Add an event"),
    eventError,
    h("label", {}, "Title", titleInput),
    h("label", {}, "Starts", startInput),
    h("label", {}, "Ends", endInput),
    h("label", {}, "Repeat", repeatSelect),
    h("button", { type: "submit" }, "Add"),
  );

  const orderError = h("p", { class: "error hidden" });
  const orderTitle = h("input", { type: "text", name: "orderTitle", required: "true" });
  const orderCustomer = h("input", { type: "text", name: "customer", required: "true" });
  const orderAddress = h("input", { type: "text", name: "address", required: "true" });
  const orderWhen = h("input", { type: "datetime-local", name: "scheduledFor", required: "true" });

  const orderForm = h(
    "form",
    {
      class: "card form",
      onsubmit: (event: Event) => {
        event.preventDefault();
        orderError.classList.add("hidden");

        const decoded = decodeForm(CreateServiceOrderInput, {
          assignee: session.profile.username,
          title: orderTitle.value,
          customer: orderCustomer.value,
          address: orderAddress.value,
          scheduledFor: localToIso(orderWhen.value),
        });
        if (decoded._tag === "failure") {
          orderError.textContent = decoded.issues.join("; ");
          orderError.classList.remove("hidden");
          return;
        }

        void run(createServiceOrder().setBody(decoded.value).pipe(toEffect))
          .then((created) => {
            const message = domainErrorMessage(created);
            if (message) {
              orderError.textContent = message;
              orderError.classList.remove("hidden");
              return;
            }
            rerender();
          })
          .catch((error: unknown) => {
            console.error("service order dispatch failed", error);
            orderError.textContent = "Could not reach the server. Is it running?";
            orderError.classList.remove("hidden");
          });
      },
    },
    h("h2", {}, "Dispatch a service order"),
    h(
      "p",
      { class: "hint" },
      "A service order is a different resource. It is never stored as a calendar entry — the " +
        "calendar projects it, because the worker has to see where they are expected to be.",
    ),
    orderError,
    h("label", {}, "Title", orderTitle),
    h("label", {}, "Customer", orderCustomer),
    h("label", {}, "Address", orderAddress),
    h("label", {}, "Scheduled for", orderWhen),
    h("button", { type: "submit" }, "Dispatch to myself"),
  );

  Match.value(result).pipe(
    Match.tag("ok", ({ body }) => {
      mount(
        main,
        h("h1", {}, "Calendar"),
        h(
          "p",
          { class: "hint" },
          `${body.entries.length} entr${body.entries.length === 1 ? "y" : "ies"} — events, repeating events, and ` +
            "assignments projected from service orders, all in one list and all a correct 200.",
        ),
        body.entries.length === 0
          ? h("p", { class: "empty" }, "Nothing scheduled.")
          : h("div", { class: "post-list" }, ...body.entries.map(renderEntry)),
        eventForm,
        session.role === "admin" ? orderForm : null,
      );
    }),
    Match.orElse(() => {
      mount(main, h("p", { class: "error" }, "Unexpected response from the server."));
    }),
  );
};
