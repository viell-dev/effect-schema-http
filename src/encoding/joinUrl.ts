import { AbsolutePathWithBaseUrl } from "../errors/AbsolutePathWithBaseUrl.js";

export const joinUrl = (baseUrl: string | undefined, path: string): string => {
  if (baseUrl === undefined) return path;
  if (URL.canParse(path)) throw new AbsolutePathWithBaseUrl(baseUrl, path);
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
};
