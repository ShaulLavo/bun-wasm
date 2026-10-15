import type { Terminal } from "@xterm/xterm";

/** Plain text, including scrollback. Soft wraps are display rows, not newlines. */
export function terminalText(term: Terminal): string {
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

export function enableTerminalCopy(term: Terminal, button: HTMLButtonElement): void {
  let reset: ReturnType<typeof setTimeout>;
  button.addEventListener("click", async () => {
    clearTimeout(reset);
    try {
      // Call in the tap handler: Safari requires clipboard writes to retain user activation.
      await navigator.clipboard.writeText(terminalText(term));
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    reset = setTimeout(() => { button.textContent = "Copy"; }, 2500);
  });
}
