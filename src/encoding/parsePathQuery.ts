import { type QueryParams } from "../request/types.js";

export const parsePathQuery = (query: string): QueryParams =>
  query.split("&").flatMap((part) => {
    if (part === "") return [];
    const parsed = new URLSearchParams(part).entries().next();
    if (parsed.done) return [];
    const [key, value] = parsed.value;
    return [[key, part.includes("=") ? value : true] as const];
  });
