import type { Terminal } from "@xterm/xterm";

/** Plain text, including scrollback. Soft wraps are display rows, not newlines. */
function terminalText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const continues = buffer.getLine(i + 1)?.isWrapped === true;
    const text = line?.translateToString(!continues) ?? "";
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join("\n").trimEnd();
}

/**
 * The Copy button's action. `show` receives the button label: "Copied" or "Copy failed"
 * after a tap, then "Copy" again 2.5 s later.
 */
export function terminalCopier(show: (label: string) => void, signal: AbortSignal): (term: Terminal) => Promise<void> {
  let reset: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", () => clearTimeout(reset));
  return async (term) => {
    clearTimeout(reset);
    try {
      // Call in the tap handler: Safari requires clipboard writes to retain user activation.
      await navigator.clipboard.writeText(terminalText(term));
      show("Copied");
    } catch {
      show("Copy failed");
    }
    reset = setTimeout(() => show("Copy"), 2500);
  };
}
