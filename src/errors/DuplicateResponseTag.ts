/** Indicates that one response declaration contains the same `_tag` more than once. */
export class DuplicateResponseTag extends Error {
  readonly name = "DuplicateResponseTag";

  /** Constructs a duplicate response-tag error. */
  constructor(
    /** Repeated response tag. */
    readonly tag: string,
    /** Declaration in which the duplicate appeared. */
    readonly owner: "api" | "request",
  ) {
    super(`Duplicate response tag ${JSON.stringify(tag)} in ${owner} declaration`);
  }
}
