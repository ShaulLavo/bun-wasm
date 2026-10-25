import { readdirSync, readFileSync } from "node:fs";

// Chromium's browser, GPU, renderer and utility processes all run the same executable.
const browserCommand = /^(headless_shell|chrome)/;

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch { return null; }
}

function children(): Map<number, { parent: number; command: string }> {
  const table = new Map<number, { parent: number; command: string }>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = read(`/proc/${name}/stat`);
    if (!stat) continue;
    const close = stat.lastIndexOf(")");
    const parent = Number(stat.slice(close + 2).split(" ")[1]);
    table.set(Number(name), { parent, command: stat.slice(stat.indexOf("(") + 1, close) });
  }
  return table;
}

function proportionalBytes(pid: number): number {
  const kib = read(`/proc/${pid}/smaps_rollup`)?.match(/^Pss:\s+(\d+) kB$/m)?.[1];
  return kib ? Number(kib) * 1024 : 0;
}

/** PSS of the Chromium processes descended from `root`: shared pages count once across them. */
function browserMemory(root: number): number {
  const table = children();
  const pending = [root];
  let bytes = 0;
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    for (const [child, entry] of table) {
      if (entry.parent !== pid) continue;
      pending.push(child);
      if (browserCommand.test(entry.command)) bytes += proportionalBytes(child);
    }
  }
  return bytes;
}

/** Samples browser PSS; `take()` returns the peak since the previous `take()`. */
export function memorySampler(root: number, intervalMs = 200) {
  let peak = 0;
  const sample = () => { peak = Math.max(peak, browserMemory(root)); };
  const timer = setInterval(sample, intervalMs);
  return {
    take(): number {
      sample();
      const value = peak;
      peak = 0;
      return value;
    },
    stop: () => clearInterval(timer),
  };
}
