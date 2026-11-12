import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve, sep } from "node:path";

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("expected nonempty string");
  return value;
}

function absolute(value: unknown): string {
  const path = string(value);
  if (!isAbsolute(path)) throw new Error(`expected absolute path: ${path}`);
  return path;
}

export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("expected finite nonnegative number");
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}

export function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function treeInventory(root: string, mutableRoots: readonly string[] = []): { path: string; kind: string; sha256: string }[] {
  root = resolve(root);
  if (mutableRoots.some(path => !path || isAbsolute(path) || path.split(/[\\/]/).includes(".."))) throw new Error("mutable roots must be relative descendants");
  const rows: { path: string; kind: string; sha256: string }[] = [];
  function visit(relative: string) {
    if (mutableRoots.some(path => relative === path || relative.startsWith(path + sep))) return;
    const full = join(root, relative);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      if (!realpathSync(full).startsWith(root + sep)) throw new Error(`input symlink escapes tree: ${full}`);
      rows.push({ path: relative, kind: "symlink", sha256: sha256(readlinkSync(full)) }); return;
    }
    if (stat.isFile()) { rows.push({ path: relative, kind: "file", sha256: sha256(readFileSync(full)) }); return; }
    if (!stat.isDirectory()) throw new Error(`unsupported input type: ${full}`);
    for (const entry of readdirSync(full).sort()) visit(join(relative, entry));
  }
  visit("");
  return rows;
}

export function identity(path: string, kind: "file" | "tree"): string {
  return kind === "file" ? sha256(readFileSync(path)) : sha256(canonical(treeInventory(path)));
}

export function parsePlan(path: string) {
  const plan = object(json(path));
  const configuration = string(plan.configuration);
  if (!["sm-shell-x86_64-interp", "sm-wasmtime-wasm32-interp", "tool-test"].includes(configuration)) throw new Error("counter captures require shell-x86_64 or wasmtime-wasm32; Chrome uses saved profiles");
  const mode = string(plan.mode);
  if (!["trace", "replay", "load"].includes(mode)) throw new Error("unknown workload mode");
  const command = array(plan.command).map(string);
  if (!isAbsolute(command[0] ?? "") || command.filter(arg => arg === "{mode}").length !== 1) throw new Error("command needs an absolute executable and exactly one {mode} argument");
  const env = Object.fromEntries(Object.entries(object(plan.env)).map(([key, value]) => [key, string(value)]));
  if (!env.PATH) throw new Error("provide an explicit PATH");
  const cpu = number(plan.cpu);
  const timeoutSeconds = number(plan.timeoutSeconds);
  if (!Number.isInteger(cpu) || timeoutSeconds === 0 || timeoutSeconds > 86400) throw new Error("invalid affinity/timeout");
  const inputs = array(plan.inputs).map<{ path: string; kind: "file" | "tree"; sha256: string; role: string }>(value => {
    const item = object(value);
    const kind = string(item.kind);
    if (kind !== "file" && kind !== "tree") throw new Error("input kind must be file or tree");
    const hash = string(item.sha256);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("input needs SHA256");
    return { path: absolute(item.path), kind, sha256: hash, role: string(item.role) };
  });
  for (const role of ["fixture", "source", "flags", "executable", "counter"]) {
    if (!inputs.some(input => input.role === role)) throw new Error(`missing input role ${role}`);
  }
  const counter = absolute(plan.counter);
  if (!inputs.some(input => input.role === "counter" && input.path === counter)) throw new Error("counter must be hashed");
  if (!inputs.some(input => input.role === "executable" && input.path === command[0])) throw new Error("executable must be hashed");
  const cacheRoots = array(plan.cacheRoots).map(absolute);
  if (cacheRoots.length === 0) throw new Error("record explicit cache roots");
  return { workload: string(plan.workload), arm: string(plan.arm), mode, configuration, sourceRevision: string(plan.sourceRevision),
    observer: string(plan.observer), command, env, cpu, timeoutSeconds, cwd: absolute(plan.cwd), counter, inputs, cacheRoots, control: object(plan.control) };
}

export type Plan = ReturnType<typeof parsePlan>;

export function verifyInputs(plan: Plan) {
  for (const input of plan.inputs) {
    if (identity(input.path, input.kind) !== input.sha256) throw new Error(`input changed: ${input.role} ${input.path}`);
  }
}

if (import.meta.main) {
  const [kind, input, output] = process.argv.slice(2);
  if ((kind !== "file" && kind !== "tree") || !input || !output) throw new Error("usage: input.ts file|tree ABSOLUTE_INPUT NEW_OUTPUT.json");
  const path = absolute(input);
  const files = kind === "tree" ? treeInventory(path) : null;
  const hash = files === null ? identity(path, "file") : sha256(canonical(files));
  writeFileSync(absolute(output), JSON.stringify({ path, kind, sha256: hash, files }, null, 2) + "\n", { flag: "wx" });
}
