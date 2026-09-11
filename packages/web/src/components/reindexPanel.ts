/**
 * Two ways to retry the same flaky endpoint, side by side, because they are not interchangeable.
 *
 * `POST /api/admin/search/reindex` answers `503` until its warm-standby cluster is up, and echoes
 * whatever `x-attempt` field the caller sent. The server does nothing else with it — it does not
 * parse it or act on it, it just reflects it — so the whole pattern lives here: this client
 * numbers its own attempts and uses the echo to confirm that a response answers the attempt it
 * just made, rather than an earlier one it had given up on.
 *
 * **The endpoint's own retry policy** (`retry: { times: 3 }` in `api.ts`) is the right default and
 * needs no code here at all: one call, the library rides through the `503`s, and the handler only
 * sees the final `202`. But the request is encoded *once*, before the retry loop, and every
 * attempt reuses it — which the library documents, and which applies to computed header values
 * too: they resolve once per evaluation, not once per attempt. So an `x-attempt` field set this
 * way carries the *same* number on all three requests. That is correct behaviour (a credential
 * must not change mid-retry) but it means the echo cannot distinguish attempts.
 *
 * **A client-driven loop** is what the echo pattern actually needs: disable the endpoint's policy
 * with `setRetries(0)` and execute the plan again per attempt, with a fresh header each time.
 * Plans are cold and re-executable, so this is a loop around `.effect`, not a second call site —
 * each iteration re-encodes and re-materializes, which is exactly the point.
 *
 * The trade is explicit: the first form is one line and handles `Retry-After` and jittered backoff
 * for you; the second gives up all of that in exchange for varying the request per attempt.
 */
import { Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { adminReindex } from "../api.js";
import { h } from "../dom.js";
import { domainErrorMessage } from "../errors.js";
import { run } from "../runtime.js";

const MAX_CLIENT_ATTEMPTS = 4;

export const renderReindexPanel = (): HTMLElement => {
  const trail = h("ol", { class: "attempt-trail hidden" });
  const status = h("p", { class: "hint hidden" });

  const reset = (message: string) => {
    trail.replaceChildren();
    trail.classList.add("hidden");
    status.textContent = message;
    status.classList.remove("hidden");
  };

  const note = (text: string) => {
    trail.classList.remove("hidden");
    trail.append(h("li", {}, text));
  };

  /** One call, the endpoint's declared policy, and a single `x-attempt` value for every attempt. */
  const withEndpointPolicy = async (): Promise<void> => {
    reset("Reindexing with the endpoint's retry policy…");
    const result = await run(adminReindex().setHeader("x-attempt", "1").pipe(toEffect));

    const message = domainErrorMessage(result);
    if (message) {
      status.textContent = message;
      return;
    }

    Match.value(result).pipe(
      Match.tag("accepted", ({ body, headers }) => {
        status.textContent = `Indexed ${body.indexed} posts. The server handled ${body.attempts} requests; the library retried inside one call.`;
        note(`echoed x-attempt: ${headers["x-attempt"] ?? "(absent)"} — the same value every attempt sent`);
        note("the request was encoded once and replayed, so the echo cannot tell the attempts apart");
      }),
      Match.tag("warmingUp", ({ body }) => {
        status.textContent = `Gave up while retrying: ${body.message}`;
      }),
      Match.orElse(() => {
        status.textContent = "Unexpected response from the server.";
      }),
    );
  };

  /** A loop this component owns, so each attempt is a genuinely different request. */
  const withClientAttempts = async (): Promise<void> => {
    reset("Reindexing with client-driven attempts…");

    for (let attempt = 1; attempt <= MAX_CLIENT_ATTEMPTS; attempt += 1) {
      const result = await run(
        adminReindex()
          // The endpoint's own policy would retry inside this call and defeat the whole exercise.
          .setRetries(0)
          .setHeader("x-attempt", String(attempt))
          .pipe(toEffect),
      );

      const echoed = result.headers["x-attempt"];
      if (echoed !== String(attempt)) {
        // The case the echo exists for: a response that does not answer the request just sent.
        note(`attempt ${attempt}: echo was ${echoed ?? "(absent)"} — discarded, not this attempt's response`);
        continue;
      }

      const message = domainErrorMessage(result);
      if (message) {
        note(`attempt ${attempt}: ${message}`);
        status.textContent = message;
        return;
      }

      const done = Match.value(result).pipe(
        Match.tag("accepted", ({ body }) => {
          note(`attempt ${attempt}: 202 accepted, echo ${echoed} — indexed ${body.indexed} posts`);
          status.textContent = `Indexed ${body.indexed} posts after ${attempt} client attempts.`;
          return true;
        }),
        Match.tag("warmingUp", () => {
          note(`attempt ${attempt}: 503 warming up, echo ${echoed} — retrying`);
          return false;
        }),
        Match.orElse(() => {
          note(`attempt ${attempt}: unexpected response`);
          status.textContent = "Unexpected response from the server.";
          return true;
        }),
      );
      if (done) return;
    }

    status.textContent = `Still warming up after ${MAX_CLIENT_ATTEMPTS} attempts.`;
  };

  const guard = (label: string, work: () => Promise<void>) =>
    h(
      "button",
      {
        type: "button",
        onclick: () => {
          void work().catch((error: unknown) => {
            console.error("reindex failed", error);
            status.textContent = "Could not reach the server. Is it running?";
          });
        },
      },
      label,
    );

  return h(
    "section",
    { class: "card form" },
    h("h2", {}, "Search index"),
    status,
    trail,
    h(
      "div",
      { class: "button-row" },
      guard("Reindex (endpoint retry policy)", withEndpointPolicy),
      guard("Reindex (client-driven attempts)", withClientAttempts),
    ),
  );
};
