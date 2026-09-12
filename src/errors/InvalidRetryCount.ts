/** Indicates that retry sugar received a non-finite, negative, or fractional count. */
export class InvalidRetryCount extends Error {
  readonly name = "InvalidRetryCount";

  /** Constructs an invalid retry-count error. */
  constructor(
    /** Invalid retry count. */
    readonly retries: number,
  ) {
    super(`Retry count must be a finite, non-negative integer; received ${String(retries)}`);
  }
}
