/** A field value, or a computation that stays data until materialization. `undefined` omits the field. */
export type Value<A = string> = A | (() => A | undefined);

/** Ordered declarations. Entries preserve repetition and their order across names. */
export type Fields<A = string> = ReadonlyArray<readonly [string, Value<A>]>;

/** Replace a name at its first position and drop its later entries, or append a new entry. */
export const set = <A>(
  fields: Fields<A>,
  name: string,
  value: Value<A>,
): Fields<A> => {
  const position = fields.findIndex(([key]) => key === name);
  if (position < 0) return [...fields, [name, value]];
  return fields.flatMap((entry, index): Array<readonly [string, Value<A>]> =>
    index === position ? [[name, value]] : entry[0] === name ? [] : [entry],
  );
};

export const append = <A>(
  fields: Fields<A>,
  name: string,
  value: Value<A>,
): Fields<A> => [...fields, [name, value]];

/** Without a value, remove the whole name. With one, remove matching static entries without evaluating computations. */
export const remove = <A>(
  fields: Fields<A>,
  name: string,
  value?: A,
): Fields<A> =>
  fields.filter(
    ([key, entry]) => key !== name || (value !== undefined && entry !== value),
  );

/** Evaluate every surviving computation once, omitting `undefined` results. */
export const resolve = <A extends string | null>(
  fields: Fields<A>,
): Array<readonly [string, A]> => {
  const output: Array<readonly [string, A]> = [];
  for (const [name, value] of fields) {
    const resolved = typeof value === "function" ? value() : value;
    if (resolved !== undefined) output.push([name, resolved]);
  }
  return output;
};
