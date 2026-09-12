import type * as Pipeable from "effect/Pipeable";

/** Applies pipeable operations to the current value. */
export const pipeSelf = function (this: unknown, ...operations: ReadonlyArray<(value: unknown) => unknown>): unknown {
  return operations.reduce<unknown>((value, operation) => operation(value), this);
} as Pipeable.Pipeable["pipe"];
