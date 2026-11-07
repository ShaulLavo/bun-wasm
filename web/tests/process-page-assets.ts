import { lstat, mkdir, readdir } from "node:fs/promises";
import type { PreparationContext } from "waffle/testing/page-runner";
import { extname, join } from "node:path";

type BundleProducer = Pick<Bun.Subprocess, "exited" | "kill">;

// A pending join stays pending after cancellation. W1 must retain scratch if its
// bounded cleanup cannot confirm this promise settled; abort alone is not a join.
export async function joinProcessBundleProducer(producer: BundleProducer, signal: AbortSignal): Promise<void> {
  let terminationError: unknown;
  const stop = () => {
    try { producer.kill("SIGKILL"); }
    catch (error) { terminationError = error; }
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) stop();
    const code = await producer.exited;
    if (terminationError !== undefined) throw new Error("process bundle termination failed before join", { cause: terminationError });
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`process supervisor bundle producer exited ${code}`);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export async function prepareProcessBundle(out: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const producer = Bun.spawn([process.execPath, import.meta.path, out], {
    stdin: "ignore", stdout: "ignore", stderr: "inherit", env: { ...process.env },
  });
  await joinProcessBundleProducer(producer, signal);
}

const mime = new Map([
  [".html", "text/html"], [".js", "text/javascript"], [".mjs", "text/javascript"],
  [".map", "application/json"], [".json", "application/json"], [".wasm", "application/wasm"],
  [".css", "text/css"], [".txt", "text/plain"], [".sha256", "text/plain"],
]);

async function collectAssets(directory: string, segments: readonly string[], assets: Record<string, Blob>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    signal.throwIfAborted();
    const path = join(directory, entry.name);
    const relative = segments.concat([entry.name]);
    if (entry.isDirectory()) {
      await collectAssets(path, relative, assets, signal);
      continue;
    }
    if (!entry.isFile()) throw new Error(`process bundle contains a non-file: ${relative.join("/")}`);
    const url = "/current/" + relative.map(encodeURIComponent).join("/");
    assets[url] = Bun.file(path, { type: mime.get(extname(entry.name)) ?? "application/octet-stream" });
  }
}

export async function processDirectoryAssets(directory: string, signal: AbortSignal): Promise<Record<string, Blob>> {
  signal.throwIfAborted();
  if (!(await lstat(directory)).isDirectory()) throw new Error("process bundle output must be a directory, not a link");
  const assets: Record<string, Blob> = {};
  await collectAssets(directory, [], assets, signal);
  signal.throwIfAborted();
  return assets;
}

export async function prepareProcessAssets(context: PreparationContext): Promise<Record<string, Blob>> {
  context.signal.throwIfAborted();
  const out = join(context.scratch, "current");
  // The host's fresh scratch owns this new directory. Never merge into old output.
  await mkdir(out);
  context.signal.throwIfAborted();
  await prepareProcessBundle(out, context.signal);
  return processDirectoryAssets(out, context.signal);
}

if (import.meta.main) {
  const [out, ...extra] = process.argv.slice(2);
  if (!out || extra.length) throw new Error("Usage: process-page-assets.ts <owned-output-directory>");
  const { processBundle } = await import("../scripts/ci-process-bundles.ts");
  await processBundle("supervisor", out);
}
