/** Symbol used by providers to retain repeated header field lines on a message. */
export const HeaderEntriesTypeId: unique symbol = Symbol.for(
  "viell-effect-schema-http/HeaderEntries",
) as typeof HeaderEntriesTypeId;
