import { on, type Handle } from "@remix-run/component";
import type { Terminal } from "@xterm/xterm";
import { copyTerminal } from "./terminal-copy";

/** Copies the terminal's text, scrollback included, and shows the outcome for 2.5 s. Shared by both pages. */
export function CopyButton(handle: Handle<{ term?: Terminal }>) {
  let text = "Copy";
  let reset: ReturnType<typeof setTimeout> | undefined;
  handle.signal.addEventListener("abort", () => clearTimeout(reset));
  const copy = on<HTMLButtonElement>("click", async () => {
    const { term } = handle.props;
    if (!term) return;
    clearTimeout(reset);
    text = await copyTerminal(term) ? "Copied" : "Copy failed";
    void handle.update();
    reset = setTimeout(() => { text = "Copy"; void handle.update(); }, 2500);
  });
  return () => (
    <button id="copy-terminal" type="button" title="Copy terminal output, including scrollback" aria-live="polite" mix={copy}>{text}</button>
  );
}
