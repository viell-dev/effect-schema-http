/**
 * Browser-side session state (token + profile), persisted to `localStorage` and exposed as a
 * tiny pub-sub store so pages can re-render on login/logout without a UI framework.
 */
import { Schema } from "effect";
import { type AuthResponse, Profile, SessionToken } from "@realworld/domain";

const STORAGE_KEY = "realworld:session";

const StoredSession = Schema.Struct({ token: SessionToken, profile: Profile });

export interface Session {
  readonly token: SessionToken;
  readonly profile: Profile;
}

let current: Session | undefined = load();
const listeners = new Set<(session: Session | undefined) => void>();

function load(): Session | undefined {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  try {
    return Schema.decodeUnknownSync(StoredSession)(JSON.parse(raw));
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return undefined;
  }
}

export const getSession = (): Session | undefined => current;

export const setSession = (auth: AuthResponse): void => {
  current = auth;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Schema.encodeSync(StoredSession)(auth)));
  for (const listener of listeners) listener(current);
};

export const clearSession = (): void => {
  current = undefined;
  localStorage.removeItem(STORAGE_KEY);
  for (const listener of listeners) listener(current);
};

export const onSessionChange = (listener: (session: Session | undefined) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
