import { h } from "../dom.js";

/**
 * A uniform way to present one API call.
 *
 * Every view in this application is a list of actions: a label, a sentence saying which
 * quirk the call exercises, and an async function that performs it and returns what it
 * found. Keeping that shape identical everywhere means the interesting part of each view
 * is the call itself rather than the markup around it, and it makes the whole UI
 * typecheck for the same reason the tests do — nothing is untyped, and every response
 * envelope has to be narrowed before its body is read.
 */
export interface Action {
  readonly label: string;
  readonly note: string;
  readonly run: () => Promise<string>;
}

/** Formats a thrown value, including Effect failures, without swallowing the reason. */
export const describeFailure = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return cause === undefined ? `${error.name}: ${error.message}` : `${error.name}: ${error.message}\n${String(cause)}`;
  }
  return String(error);
};

/** A labelled group of actions sharing one output pane. */
export const actionPanel = (title: string, blurb: string, actions: ReadonlyArray<Action>): HTMLElement => {
  const output = h("pre", { class: "output" }, "Ready.");

  const write = (text: string) => {
    output.textContent = text;
  };

  const buttons = actions.map((action) => {
    const button = h("button", { class: "btn" }, action.label);
    button.title = action.note;
    button.onclick = async () => {
      button.disabled = true;
      write(`${action.label}\n${action.note}\n\nrunning…`);
      try {
        const result = await action.run();
        write(`${action.label}\n${action.note}\n\n${result}`);
      } catch (error) {
        write(`${action.label}\n${action.note}\n\nfailed: ${describeFailure(error)}`);
      } finally {
        button.disabled = false;
      }
    };
    return button;
  });

  return h(
    "section",
    { class: "panel" },
    h("h2", {}, title),
    h("p", { class: "blurb" }, blurb),
    h("div", { class: "actions" }, ...buttons),
    output,
  );
};

/** A labelled text input, returned with its element so a caller can read it. */
export const field = (label: string, value = ""): { readonly row: HTMLElement; readonly input: HTMLInputElement } => {
  const input = h("input", { type: "text", value }) as HTMLInputElement;
  input.value = value;
  return { row: h("label", { class: "field" }, h("span", {}, label), input), input };
};

/** Pretty-prints a decoded value, including the Effect types a JSON serializer mangles. */
export const show = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (item instanceof Uint8Array) return `Uint8Array(${item.byteLength} bytes)`;
      if (typeof item === "object" && item !== null && "epochMillis" in item) {
        return new Date((item as { readonly epochMillis: number }).epochMillis).toISOString();
      }
      return item;
    },
    2,
  );
