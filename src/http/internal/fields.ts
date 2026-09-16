/** Computations remain data until materialization. Maps also avoid prototype-key collisions. */
export type Value = string | (() => string | undefined);
export type Fields = ReadonlyMap<string, ReadonlyArray<Value>>;

export const set = (fields: Fields, key: string, value: Value, append = false): Fields => {
  const copy = new Map(fields);
  copy.set(key, append ? [...(copy.get(key) ?? []), value] : [value]);
  return copy;
};

export const remove = (fields: Fields, key: string, value?: string): Fields => {
  const copy = new Map(fields);
  if (value === undefined) copy.delete(key);
  else
    copy.set(
      key,
      (copy.get(key) ?? []).filter((entry) => entry !== value),
    );
  return copy;
};

export const resolve = (fields: Fields): Array<readonly [string, string]> => {
  const output: Array<readonly [string, string]> = [];
  for (const [key, values] of fields) {
    for (const value of values) {
      const resolved = typeof value === "function" ? value() : value;
      if (resolved !== undefined) output.push([key, resolved]);
    }
  }
  return output;
};
