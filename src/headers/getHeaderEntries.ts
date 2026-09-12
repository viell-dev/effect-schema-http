import { Cookies, Headers } from "@effect/platform";
import { type HeaderEntries, type HeaderEntriesCarrier } from "../request/types.js";
import { headerEntriesFromInput } from "./headerEntriesFromInput.js";
import { HeaderEntriesTypeId } from "./HeaderEntriesTypeId.js";
import { resolveHeaderEntries } from "./resolveHeaderEntries.js";

/**
 * Reads lossless header entries from a message, falling back to normalized headers and parsed cookies.
 *
 * @param message - Request or response-like message.
 * @returns Ordered lower-case header entries.
 * @public
 */
export const getHeaderEntries = (message: {
  readonly headers: Headers.Headers;
  readonly cookies?: unknown;
}): HeaderEntries => {
  const attached = (message as HeaderEntriesCarrier)[HeaderEntriesTypeId];
  if (attached !== undefined) return attached;

  const entries = resolveHeaderEntries(headerEntriesFromInput(message.headers));
  if (!Cookies.isCookies(message.cookies)) return entries;
  const setCookie = Cookies.toSetCookieHeaders(message.cookies);
  return setCookie.length === 0
    ? entries
    : [
        ...entries.filter(([name]) => name !== "set-cookie"),
        ...setCookie.map((value) => ["set-cookie", value] as const),
      ];
};
