/** Startup measurements use the page's navigation clock and appear in the Performance panel. */
export function measureStartup(name: string, start: number, detail?: unknown): void {
  performance.measure(`bunwasm:${name}`, { start, end: performance.now(), detail });
}
