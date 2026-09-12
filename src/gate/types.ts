import type { Effect } from "effect";
import type { GateClosed } from "../errors/GateClosed.js";

/** Input equivalence defines reuse within one interaction. Include account and other relevant context in the key. */
export interface RequestGateOptions<Input, Key> {
  readonly key: (input: Input) => Key;
  readonly equivalent?: (left: Key, right: Key) => boolean;
}

export interface RequestGateRunOptions {
  /** Start a fresh execution, interrupting existing work even for equivalent input. */
  readonly force?: boolean;
}

/** One interaction: latest input owns execution; one successful value can be reused. */
export interface RequestGate<Input, A, E, R> {
  /** Join equivalent work, otherwise interrupt previous work and reuse an equivalent success or execute. */
  readonly run: (input: Input, options?: RequestGateRunOptions) => Effect.Effect<A, E | GateClosed, R>;
  /** Permanently close the gate, clear retention, interrupt all owned work, and wait for cleanup. Idempotent. */
  readonly dispose: Effect.Effect<void>;
}
