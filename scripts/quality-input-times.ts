import { createHash } from "node:crypto";
import { existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, readdirSync, readlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

type InputTime = { hash: string; mtime: number };
type Receipt = Map<string, InputTime>;

function readReceipt(path: string): Receipt {
  if (!existsSync(path)) return new Map();
  const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(rows)) throw new Error("Invalid input-time receipt");
  const receipt: Receipt = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== "string" || typeof row[1] !== "string" || typeof row[2] !== "number" || !Number.isFinite(row[2])) throw new Error("Invalid input-time entry");
    if (receipt.has(row[0])) throw new Error("Duplicate input-time entry");
    receipt.set(row[0], { hash: row[1], mtime: row[2] });
  }
  return receipt;
}

function scan(path: string, state: { root: string; previous: Receipt; next: Receipt; now: number }): string {
  const stat = lstatSync(path);
  const contents = stat.isDirectory()
    ? JSON.stringify(readdirSync(path).sort().map(name => [name, scan(join(path, name), state)]))
    : stat.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : readFileSync(path);
  const hash = createHash("sha256").update(`${stat.mode}:`).update(contents).digest("hex");
  const key = relative(state.root, path);
  const saved = state.previous.get(key);
  const mtime = saved?.hash === hash ? saved.mtime : state.now;
  const setTimes = stat.isSymbolicLink() ? lutimesSync : utimesSync;
  setTimes(path, stat.atimeMs / 1000, mtime / 1000);
  state.next.set(key, { hash, mtime });
  return hash;
}

export function preserveInputTimes(root: string, receiptPath: string, inputs: readonly string[]): void {
  const state = { root, previous: readReceipt(receiptPath), next: new Map<string, InputTime>(), now: Date.now() };
  for (const input of inputs) {
    const path = join(root, input);
    if (existsSync(path)) scan(path, state);
  }
  writeFileSync(receiptPath, JSON.stringify(Array.from(state.next, ([path, time]) => [path, time.hash, time.mtime])));
}

if (import.meta.main) {
  const target = process.env.CARGO_TARGET_DIR;
  if (!target) throw new Error("CARGO_TARGET_DIR is required");
  mkdirSync(target, { recursive: true });
  preserveInputTimes(process.cwd(), join(target, ".ci-input-times.json"), ["crates", "third_party", "scripts", ".cargo", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "bun.lock", "env.sh"]);
}
