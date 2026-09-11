export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly username?: string;
  readonly expiresAt?: number;
}

const STORAGE_KEY = "test_llm1_2_session";

let currentSession: Session | undefined = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : undefined;
  } catch {
    return undefined;
  }
})();

const listeners = new Set<(session: Session | undefined) => void>();

export const getSession = (): Session | undefined => currentSession;

export const setSession = (session: Session): void => {
  currentSession = session;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // LocalStorage may be unavailable in some test environments
  }
  for (const listener of listeners) {
    listener(currentSession);
  }
};

export const clearSession = (): void => {
  currentSession = undefined;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
  for (const listener of listeners) {
    listener(undefined);
  }
};

export const onSessionChange = (
  listener: (session: Session | undefined) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
