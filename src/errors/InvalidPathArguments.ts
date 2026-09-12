/** Indicates that runtime path arguments do not exactly match the path template. */
export class InvalidPathArguments extends Error {
  readonly name = "InvalidPathArguments";

  /** Constructs a path-argument validation error. */
  constructor(
    /** Configured path template. */
    readonly path: string,
    /** Parameter names inferred from the template. */
    readonly expected: ReadonlyArray<string>,
    /** Keys received from the runtime argument object. */
    readonly received: ReadonlyArray<string>,
    /** Number of runtime arguments supplied. */
    readonly argumentCount: number,
  ) {
    super(
      expected.length === 0
        ? `Path ${JSON.stringify(path)} does not accept arguments; received ${argumentCount}`
        : `Path ${JSON.stringify(path)} requires one parameter object with exactly ${JSON.stringify(expected)}; received ${argumentCount} arguments with keys ${JSON.stringify(received)}`,
    );
  }
}
