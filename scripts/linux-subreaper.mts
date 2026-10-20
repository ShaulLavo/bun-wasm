import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const reaperArgument = "--deadline-subreaper";

async function setSubreaper(): Promise<void> {
  const { dlopen } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } });
  const setChildSubreaper = 36;
  try {
    if (libc.symbols.prctl(setChildSubreaper, 1, 0, 0, 0) !== 0) throw new Error("cannot enable child subreaping");
  } finally { libc.close(); }
}

export async function enableSubreaper(): Promise<void> {
  if (process.platform !== "linux") return;
  if (process.versions.bun) return setSubreaper();
  if (process.argv[2] === reaperArgument) {
    process.argv.splice(2, 1);
    return;
  }
  const executable = spawnSync("bun", ["-p", "process.execPath"], { encoding: "utf8" });
  if (executable.error) throw executable.error;
  if (executable.status !== 0) throw new Error(`cannot locate Bun for Linux child subreaping: ${executable.stderr}`);
  const bun = executable.stdout.trim();
  const [script, ...args] = process.argv.slice(1);
  if (!script) throw new Error("supervisor script missing");
  const argv = [bun, fileURLToPath(import.meta.url), process.execPath].concat(process.execArgv, [script, reaperArgument], args);
  process.execve?.(bun, argv, process.env);
  throw new Error("Linux deadline supervision requires process.execve");
}

if (import.meta.main) {
  await enableSubreaper();
  const [runtime, ...args] = process.argv.slice(2);
  if (!runtime || args.length === 0) throw new Error("missing supervisor runtime or arguments");
  const { dlopen, ptr } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", { execvp: { args: ["ptr", "ptr"], returns: "i32" } });
  const strings = [runtime].concat(args).map(value => Buffer.from(`${value}\0`));
  const pointers = new BigUint64Array(strings.length + 1);
  strings.forEach((value, index) => { pointers[index] = BigInt(ptr(value)); });
  libc.symbols.execvp(Buffer.from(`${runtime}\0`), pointers);
  throw new Error(`cannot execute deadline supervisor: ${runtime}`);
}
