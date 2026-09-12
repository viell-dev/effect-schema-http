/** Indicates that a full absolute request URL was combined with an API base URL. */
export class AbsolutePathWithBaseUrl extends Error {
  readonly name = "AbsolutePathWithBaseUrl";

  /** Constructs an absolute-path/base-URL conflict error. */
  constructor(
    /** Configured API base URL. */
    readonly baseUrl: string,
    /** Absolute endpoint path that cannot be joined to the base URL. */
    readonly path: string,
  ) {
    super(`Cannot combine base URL ${JSON.stringify(baseUrl)} with absolute path ${JSON.stringify(path)}`);
  }
}
