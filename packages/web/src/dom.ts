/** Minimal, dependency-free DOM builder. Uses `textContent`/`createTextNode` exclusively for
 * string children (never `innerHTML`) so post bodies and comments — arbitrary user input — can
 * never be interpreted as markup. */
export type Child = Node | string | number | null | undefined | false;

type Attrs = Readonly<Record<string, string | EventListener | undefined>>;

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: ReadonlyArray<Child>
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined) continue;
    if (key.startsWith("on")) {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = value as string;
    } else {
      el.setAttribute(key, value as string);
    }
  }
  append(el, children);
  return el;
};

export const append = (el: Element, children: ReadonlyArray<Child>): void => {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
};

export const mount = (root: Element, ...children: ReadonlyArray<Child>): void => {
  root.replaceChildren();
  append(root, children);
};

export const text = (value: string): Text => document.createTextNode(value);
