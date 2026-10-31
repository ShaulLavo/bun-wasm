/** Startup measurements use the page's navigation clock and appear in the Performance panel. */
export function measureStartup(name: string, start: number, detail?: unknown): void {
  performance.measure(`bunwasm:${name}`, { start, end: performance.now(), detail });
}

/** Typed startup refusals (UNSUPPORTED_VFS, workspace ownership) lead with their code. */
export function errorText(error: unknown): string {
  return error instanceof Error && "code" in error ? `${String(error.code)}: ${error.message}` : String(error);
}
