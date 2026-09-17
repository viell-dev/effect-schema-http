/** Computations remain data until materialization. Maps avoid prototype-key collisions. */
export type Value<A = string> = A | (() => A | undefined);
export type Fields<A = string> = ReadonlyMap<string, ReadonlyArray<Value<A>>>;

export const set = <A>(fields: Fields<A>, key: string, value: Value<A>, append = false): Fields<A> => {
  const copy = new Map(fields);
  copy.set(key, append ? [...(copy.get(key) ?? []), value] : [value]);
  return copy;
};

export const remove = <A>(fields: Fields<A>, key: string, value?: A): Fields<A> => {
  const copy = new Map(fields);
  if (value === undefined) copy.delete(key);
  else
    copy.set(
      key,
      (copy.get(key) ?? []).filter((entry) => entry !== value),
    );
  return copy;
};

export const resolve = <A extends string | null>(fields: Fields<A>): Array<readonly [string, A]> => {
  const output: Array<readonly [string, A]> = [];
  for (const [key, values] of fields) {
    for (const value of values) {
      const resolved = typeof value === "function" ? value() : value;
      if (resolved !== undefined) output.push([key, resolved]);
    }
  }
  return output;
};
