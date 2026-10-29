import { on, ref, type Handle } from "@remix-run/component";
import type { Terminal } from "@xterm/xterm";
import { terminalCopier } from "../../web/src/terminal-copy";
import type { Sandbox } from "./sandbox";

export function TerminalPane(handle: Handle<{ sandbox: Sandbox }>) {
  return () => {
    const { sandbox } = handle.props;
    const { term } = sandbox;
    return (
      <section class="pane terminal-pane" aria-label="Dev server output">
        <div class="bar">
          <span>Terminal</span>
          <span class="dim">bun ./index.html</span>
          <CopyButton term={term} />
        </div>
        {term ? <TerminalHost key="term" term={term} sandbox={sandbox} /> : <div id="terminal" />}
      </section>
    );
  };
}

/** Opens the sandbox's output-only xterm once; later renders leave its DOM alone. */
function TerminalHost(handle: Handle<{ term: Terminal; sandbox: Sandbox }>) {
  const open = ref((node, signal) => handle.props.sandbox.openTerminal(handle.props.term, node as HTMLElement, signal));
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
