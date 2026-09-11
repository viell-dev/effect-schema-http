import { Effect, Schema } from "effect";
import { makeRequestGate, toEffect } from "viell-effect-schema-http";
import { ExtractRecordToTaskDraft, type TaskDraft } from "./translate.js";
import { search } from "../services/apiClient.js";
import { fetchExtract } from "../services/reportClient.js";

/**
 * Request gates over two services at once.
 *
 * `makeRequestGate` adds single-entry memoization and in-flight de-duplication around
 * any input-to-Effect function. The README's motivating example is a filter-as-you-type
 * table over one endpoint; this is the same idea where the "endpoint" is two services
 * and a translation between them, which is the case a multi-service client actually has.
 *
 * The important thing the docs say plainly, and which is easy to get wrong: retention is
 * a **correctness** guarantee, not a cancellation one. `run` does not abort the previous
 * flight; it only stops an older completion overwriting a newer one. A live filter box
 * wants the stale request to stop on the wire as well, which is what `cancel` is for.
 */

/** What the reconciliation screen shows: live matches, and drafts from the nightly file. */
export interface ReconciliationView {
  readonly term: string;
  readonly liveMatches: number;
  readonly drafts: ReadonlyArray<TaskDraft>;
}

/**
 * One gate over two services.
 *
 * The Java search and the Perl extract are fetched concurrently — they share nothing, so
 * there is no reason to serialize them — and the extract's records are translated into
 * task drafts before they are shown, so the screen compares like with like.
 *
 * Both halves therefore sit behind one key. That is the right granularity here: the
 * screen is one thing, and a partially-refreshed screen would be worse than a slower
 * one. Where two halves genuinely refresh independently, the library's own design notes
 * record that whole-gate cancellation is a deliberate simplification and one gate per
 * key is the answer.
 */
export const makeReconciliationGate = () =>
  makeRequestGate(
    (term: string) =>
      Effect.gen(function* () {
        const [live, extract] = yield* Effect.all(
          [search(term).pipe(toEffect), fetchExtract().pipe(toEffect)],
          { concurrency: "unbounded" },
        );

        const drafts =
          extract._tag === "ok"
            ? yield* Effect.forEach(
                extract.body.records.filter((record) =>
                  record.description.toLowerCase().includes(term.toLowerCase()),
                ),
                (record) => Schema.decode(ExtractRecordToTaskDraft)(record),
              )
            : [];

        return {
          term,
          liveMatches: live._tag === "ok" ? live.body.length : 0,
          drafts,
        } satisfies ReconciliationView;
      }),
    { key: (term) => term.trim().toLowerCase() },
  );

/**
 * Supersede an in-flight query.
 *
 * `cancel` interrupts everything the gate currently owns, stops those executions
 * repopulating the cache, and **keeps** the retained success — so correcting a typo back
 * to a term that already resolved costs no request at all. `invalidate` would also throw
 * that away, which is right after a mutation and wrong here.
 */
export const applyTerm = (
  gate: Effect.Effect.Success<ReturnType<typeof makeReconciliationGate>>,
  term: string,
) => gate.cancel.pipe(Effect.zipRight(gate.run(term)));
