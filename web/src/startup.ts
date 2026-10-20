/** Startup measurements use the page's navigation clock and appear in the Performance panel. */
export function measureStartup(name: string, start: number, detail?: unknown): void {
  performance.measure(`bunwasm:${name}`, { start, end: performance.now(), detail });
}

/** Construction can fail before a filesystem, editor or terminal exists. */
export function showPageStartupFailure(error: unknown, options: {
  button: string;
  disable: string;
  title: string;
}): void {
  console.error(error);
  const status = document.querySelector<HTMLElement>("#status");
  if (status) {
    status.textContent = error instanceof Error && "code" in error ? `${String(error.code)}: ${error.message}` : String(error);
    status.dataset.kind = "error";
  }
  const button = document.querySelector<HTMLButtonElement>(options.button);
  if (button) {
    button.textContent = "Reload";
    button.disabled = false;
    button.title = options.title;
    button.onclick = () => location.reload();
  }
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(options.disable)) control.disabled = true;
}
