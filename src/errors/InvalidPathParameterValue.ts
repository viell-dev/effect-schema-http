/** Indicates that a path parameter is not a string. */
export class InvalidPathParameterValue extends Error {
  readonly name = "InvalidPathParameterValue";

  /** Constructs a path-parameter value error. */
  constructor(
    /** Configured path template. */
    readonly path: string,
    /** Invalid parameter name. */
    readonly parameter: string,
    /** Validation condition that failed. */
    readonly reason: "not-string",
  ) {
    super(
      `Path parameter ${JSON.stringify(parameter)} for ${JSON.stringify(path)} must be a string; received a non-string value`,
    );
  }
}
