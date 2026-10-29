import { on, ref, type Handle } from "@remix-run/component";
import type { Terminal } from "@xterm/xterm";
import { copyTerminal } from "../terminal-copy";
import type { Playground } from "./playground";

export function TerminalPane(handle: Handle<{ playground: Playground }>) {
  return () => {
    const { playground } = handle.props;
    const { term } = playground;
    return (
      <section class="pane terminal-pane" aria-label="Terminal">
        <div class="bar">
          <span>Terminal</span>
          <CopyButton term={term} />
        </div>
        {term ? <TerminalHost key="term" term={term} playground={playground} /> : <div id="terminal" />}
      </section>
    );
  };
}

/** Opens the playground's xterm once; later renders leave its DOM alone. */
function TerminalHost(handle: Handle<{ term: Terminal; playground: Playground }>) {
  const open = ref((node, signal) => {
    const { term, playground } = handle.props;
    const element = node as HTMLElement;
    playground.openTerminal(term, element, signal);
    // iOS only raises the keyboard when focus happens inside the tap's own event handler.
    element.addEventListener("touchend", () => term.focus(), { passive: true, signal });
    element.addEventListener("click", () => term.focus(), { signal });
  });
  return () => <div id="terminal" mix={open} />;
}

function CopyButton(handle: Handle<{ term?: Terminal }>) {
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
