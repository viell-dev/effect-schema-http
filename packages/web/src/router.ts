export type RouteHandler = (params: Readonly<Record<string, string>>) => void | Promise<void>;

interface Route {
  readonly pattern: RegExp;
  readonly keys: ReadonlyArray<string>;
  readonly handler: RouteHandler;
}

const routes: Array<Route> = [];

const compile = (path: string): { pattern: RegExp; keys: ReadonlyArray<string> } => {
  const keys: Array<string> = [];
  const pattern = path.replace(/:([a-zA-Z_]+)/g, (_match, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${pattern}$`), keys };
};

export const addRoute = (path: string, handler: RouteHandler): void => {
  const { pattern, keys } = compile(path);
  routes.push({ pattern, keys, handler });
};

const currentPath = (): string => {
  const hash = location.hash.replace(/^#/, "");
  return hash === "" ? "/" : hash;
};

const dispatch = (): void => {
  const path = currentPath();
  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1] ?? "");
    });
    void route.handler(params);
    return;
  }
  location.hash = "#/";
};

export const startRouter = (): void => {
  window.addEventListener("hashchange", dispatch);
  dispatch();
};

export const navigate = (path: string): void => {
  location.hash = `#${path}`;
};
