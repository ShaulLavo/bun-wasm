import { on, ref, type Handle } from "@remix-run/component";
import type { Terminal } from "@xterm/xterm";
import { terminalCopier } from "../terminal-copy";
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
  const copyTerminal = terminalCopier((label) => { text = label; void handle.update(); }, handle.signal);
  const copy = on<HTMLButtonElement>("click", () => {
    const { term } = handle.props;
    if (term) void copyTerminal(term);
  });
  return () => (
    <button id="copy-terminal" type="button" title="Copy terminal output, including scrollback" aria-live="polite" mix={copy}>{text}</button>
  );
}
