/** Computations remain data until materialization. Entries preserve cross-name order. */
export type Value<A = string> = A | (() => A | undefined);
export type Fields<A = string> = ReadonlyArray<readonly [string, Value<A>]>;

export const set = <A>(fields: Fields<A>, key: string, value: Value<A>, append = false): Fields<A> => {
  if (append) return [...fields, [key, value]];
  const position = fields.findIndex(([name]) => name === key);
  if (position < 0) return [...fields, [key, value]];
  return fields.flatMap((entry, index): Array<readonly [string, Value<A>]> =>
    index === position ? [[key, value]] : entry[0] === key ? [] : [entry],
  );
};

export const remove = <A>(fields: Fields<A>, key: string, value?: A): Fields<A> =>
  fields.filter(([name, entry]) => name !== key || (value !== undefined && entry !== value));

export const resolve = <A extends string | null>(fields: Fields<A>): Array<readonly [string, A]> => {
  const output: Array<readonly [string, A]> = [];
  for (const [key, value] of fields) {
    const resolved = typeof value === "function" ? value() : value;
    if (resolved !== undefined) output.push([key, resolved]);
  }
  return output;
};
