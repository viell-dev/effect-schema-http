import { InvalidPathArguments } from "../errors/InvalidPathArguments.js";
import { InvalidPathParameterValue } from "../errors/InvalidPathParameterValue.js";

export const fillPath = (
  path: string,
  pathArguments: ReadonlyArray<unknown>,
  encode: (value: string) => string = encodeURIComponent,
): string => {
  const parameterPattern = /(?<!\\):([A-Za-z_][A-Za-z0-9_]*)/g;
  const expected = Array.from(new Set(Array.from(path.matchAll(parameterPattern), ([, name]) => name!)));

  if (expected.length === 0) {
    if (
      pathArguments.length !== 0 &&
      !(
        pathArguments.length === 1 &&
        typeof pathArguments[0] === "object" &&
        pathArguments[0] !== null &&
        Object.keys(pathArguments[0]).length === 0
      )
    )
      throw new InvalidPathArguments(path, expected, [], pathArguments.length);
    return path.replaceAll("\\:", ":");
  }

  const candidate = pathArguments[0];
  const isParameterObject =
    pathArguments.length === 1 && typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  const parameters = isParameterObject ? (candidate as Readonly<Record<string, unknown>>) : undefined;
  const received = parameters === undefined ? [] : Object.keys(parameters);
  if (
    parameters === undefined ||
    received.length !== expected.length ||
    expected.some((name) => !Object.hasOwn(parameters, name)) ||
    received.some((name) => !expected.includes(name))
  ) {
    throw new InvalidPathArguments(path, expected, received, pathArguments.length);
  }

  for (const name of expected) {
    const value = parameters[name];
    if (typeof value !== "string") throw new InvalidPathParameterValue(path, name, "not-string");
  }

  return path.replace(parameterPattern, (_, name: string) => encode(parameters[name] as string)).replaceAll("\\:", ":");
};
