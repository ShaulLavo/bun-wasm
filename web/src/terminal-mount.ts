import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/** Opens a page model's terminal into the element its component rendered, and keeps it fitted. */
export function openTerminal(term: Terminal, fit: FitAddon, node: HTMLElement, signal: AbortSignal): void {
  term.open(node);
  fit.fit();
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(node);
  signal.addEventListener("abort", () => observer.disconnect());
}
