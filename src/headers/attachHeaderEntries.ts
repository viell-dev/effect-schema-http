import { type HeaderInput } from "../request/types.js";
import { headerEntriesFromInput } from "./headerEntriesFromInput.js";
import { HeaderEntriesTypeId } from "./HeaderEntriesTypeId.js";
import { resolveHeaderEntries } from "./resolveHeaderEntries.js";

/**
 * Attaches lossless ordered header entries to a request or response object.
 *
 * @remarks
 * Providers can use this hook when their native header representation preserves repeated fields. The attachment is
 * non-enumerable and does not alter the message's normalized `headers` value.
 *
 * @param message - Message that should carry the entries.
 * @param input - Header entries to retain.
 * @returns The same message instance.
 * @public
 */
export const attachHeaderEntries = <Message extends object>(message: Message, input: HeaderInput): Message => {
  Object.defineProperty(message, HeaderEntriesTypeId, {
    configurable: true,
    // Provider-supplied fields are already materialized; a computed value here is resolved immediately.
    value: resolveHeaderEntries(headerEntriesFromInput(input)),
  });
  return message;
};
