import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";
import { bounded } from "./bounded";
import { parseTimeout } from "./deadlines";
import { CommandExitError, withSignals } from "./lifetime";

interface ReadyMessage { iphoneControl: string; productOrigin: string }
interface NativeReadyOptions {
  logFile: string;
  exitFile: string;
  errorFile?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function readyMessage(line: string): ReadyMessage | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!value || typeof value !== "object") return;
  if ("error" in value && typeof value.error === "string") throw new Error("Native server reported an error before readiness");
  if (!("iphoneControl" in value) || typeof value.iphoneControl !== "string" || !value.iphoneControl) return;
  if (!("productOrigin" in value) || typeof value.productOrigin !== "string" || !value.productOrigin) return;
  return { iphoneControl: value.iphoneControl, productOrigin: value.productOrigin };
}

function current(options: NativeReadyOptions): ReadyMessage | undefined {
  if (options.errorFile && readOptional(options.errorFile) !== undefined) throw new Error("Native server error marker exists before readiness");
  const exit = readOptional(options.exitFile)?.trim();
  if (exit) throw new Error("Queue exited before a server-ready message");
  for (const line of (readOptional(options.logFile) ?? "").split("\n")) {
    const ready = readyMessage(line);
    if (ready) return ready;
  }
}

export async function waitNativeReady(options: NativeReadyOptions, observe: (directory: string, changed: () => void) => FSWatcher = watch): Promise<ReadyMessage> {
  const watchers: FSWatcher[] = [];
  const paths = [options.logFile, options.exitFile].concat(options.errorFile ? [options.errorFile] : []);
  const directories = new Set(paths.map(path => dirname(resolve(path))));
  try {
    return await bounded(() => new Promise<ReadyMessage>((accept, reject) => {
      const check = () => {
        try { const ready = current(options); if (ready) accept(ready); }
        catch (error) { reject(error); }
      };
      for (const directory of directories) watchers.push(observe(directory, check).on("error", reject));
      // A marker can arrive before fs.watch starts delivering events.
      options.signal?.throwIfAborted();
      check();
    }), options.timeoutMs, options.signal);
  } finally { for (const watcher of watchers) watcher.close(); }
}

function cliOptions(args: string[]): NativeReadyOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !["--log-file", "--exit-file", "--error-file", "--timeout-ms"].includes(key) || !value || values.has(key)) throw new Error("Expected --log-file PATH --exit-file PATH [--error-file PATH] --timeout-ms N");
    values.set(key, value);
  }
  const logFile = values.get("--log-file"), exitFile = values.get("--exit-file"), timeout = values.get("--timeout-ms");
  if (!logFile || !exitFile || !timeout) throw new Error("Require log-file, exit-file and timeout-ms");
  return { logFile, exitFile, errorFile: values.get("--error-file"), timeoutMs: parseTimeout(timeout) };
}

if (import.meta.main) {
  try {
    const options = cliOptions(process.argv.slice(2));
    const ready = await withSignals(signal => waitNativeReady({ ...options, signal }));
    console.log(JSON.stringify(ready));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Native readiness failed");
    process.exitCode = error instanceof CommandExitError ? error.code : 1;
  }
}
