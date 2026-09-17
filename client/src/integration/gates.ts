import { Effect, Schema } from "effect";
import { Interaction } from "viell-effect-schema-http";
import { search } from "../services/apiClient.js";
import { fetchExtract } from "../services/reportClient.js";
import { ExtractRecordToTaskDraft, type TaskDraft } from "./translate.js";

/** One gate owns each reconciliation interaction, including automatic interruption and retained success. */

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
  Interaction.make(
    (term: string) =>
      Effect.gen(function* () {
        if (term.trim() === "") return { term, liveMatches: 0, drafts: [] } satisfies ReconciliationView;
        const [live, extract] = yield* Effect.all([search(term), fetchExtract().execute(undefined)], {
          concurrency: "unbounded",
        });

        const drafts =
          extract._tag === "ok"
            ? yield* Effect.forEach(
                extract.value.records.filter((record) => record.description.toLowerCase().includes(term.toLowerCase())),
                (record) => Schema.decode(ExtractRecordToTaskDraft)(record),
              )
            : [];

        return {
          term,
          liveMatches: live._tag === "ok" ? live.value.length : 0,
          drafts,
        } satisfies ReconciliationView;
      }),
    { equivalence: (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase(), retain: () => true },
  );

/** Submit the next input; the gate itself interrupts superseded work. */
export const applyTerm = (gate: Effect.Effect.Success<ReturnType<typeof makeReconciliationGate>>, term: string) =>
  gate.run(term);
