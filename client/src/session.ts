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

/**
 * The reporting gateway's own session.
 *
 * It has no connection to the OAuth session above: the gateway predates it by twenty
 * years, hands out an opaque id from a query string, and expects it back the same way.
 * Keeping the two separate is deliberate — one credential per trust domain, and neither
 * service can be persuaded to accept the other's.
 */
let reportSession: string | undefined;

export const getReportSession = (): string | undefined => reportSession;

export const setReportSession = (session: string | undefined): void => {
  reportSession = session;
};
