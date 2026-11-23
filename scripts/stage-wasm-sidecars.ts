import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

export type Writer = (path: string, bytes: Uint8Array) => Promise<void>;

/**
 * Write a raw program WASM plus `.br` and `.gz` twins. Hosts pick one by Accept-Encoding and send it
 * with a native Content-Encoding (site/worker.ts, web/serve.ts), so a plain fetch of the logical URL
 * gets the smaller download. Brotli quality 11 costs about 3 s on the 2.3 MB shell guest and cuts
 * its wire size by about a quarter compared with Cloudflare's on-the-fly Brotli.
 *
 * All three land in temporary files first and replace the targets only after every write succeeded,
 * so a failed write never leaves a raw file beside twins of different bytes.
 */
export async function writeWasmWithSidecars(path: string, bytes: Uint8Array, write: Writer = writeFile): Promise<void> {
  const [br, gz] = await Promise.all([
    brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } }),
    gzipped(bytes, { level: 9 }),
  ]);
  await replaceFiles([[path, bytes], [`${path}.gz`, gz], [`${path}.br`, br]], write);
}

type Mover = (from: string, to: string) => Promise<void>;

/**
 * Write every output to a temporary file first and rename them into place only after all writes
 * succeeded. On failure every writer has settled, every temporary file is gone, and the targets
 * hold exactly what they held before: no new file beside an old one.
 */
export async function replaceFiles(outputs: readonly [string, Uint8Array][], write: Writer = writeFile, move: Mover = rename): Promise<void> {
  const suffix = `.${process.pid}-${randomUUID()}.tmp`;
  const targets = outputs.map(([target]) => target);
  await Promise.all(Array.from(new Set(targets.map(target => dirname(target))), directory => mkdir(directory, { recursive: true })));
  try {
    await writeAll(outputs, suffix, write);
    await requireFileTargets(targets);
    await swapIntoPlace(targets, suffix, move);
  } finally {
    await Promise.all(targets.map(target => rm(target + suffix, { force: true })));
  }
}

/** Move each previous file aside, then each new one in; any failed rename puts the previous set back. */
async function swapIntoPlace(targets: readonly string[], suffix: string, move: Mover): Promise<void> {
  const swap = { previous: `${suffix}.previous`, kept: [] as string[], placed: [] as string[] };
  try {
    for (const target of targets) await placeOne(target, suffix, swap, move);
  } catch (error) {
    const failures = await rollBack(swap, move);
    if (!failures.length) throw error;
    throw new AggregateError([error].concat(failures), `${String(error)}; rolling back also failed, so a ${swap.previous} backup may remain`, { cause: error });
  }
  await Promise.all(swap.kept.map(target => rm(target + swap.previous, { force: true })));
}

/**
 * Remove each placed file and restore each backup independently, so one failed step never skips
 * the others. A backup whose restore fails stays beside its target, where it can be recovered.
 */
async function rollBack(swap: { previous: string; kept: string[]; placed: string[] }, move: Mover): Promise<unknown[]> {
  const failures: unknown[] = [];
  const step = async (action: () => Promise<void>) => { await action().catch((error: unknown) => { failures.push(error); }); };
  for (const target of swap.placed) await step(() => rm(target, { force: true }));
  for (const target of swap.kept) await step(() => move(target + swap.previous, target));
  return failures;
}

async function placeOne(target: string, suffix: string, swap: { previous: string; kept: string[]; placed: string[] }, move: Mover): Promise<void> {
  if (await present(target)) {
    await move(target, target + swap.previous);
    swap.kept.push(target);
  }
  await move(target + suffix, target);
  swap.placed.push(target);
}

async function present(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

/** Wait for every write, so none can recreate a temporary file after cleanup, then report the first failure. */
async function writeAll(outputs: readonly [string, Uint8Array][], suffix: string, write: Writer): Promise<void> {
  await settleAll(outputs.map(async ([target, data]) => write(target + suffix, data)));
}

/** Like Promise.all, but a failure is reported only after every task settled, so none is still writing. */
export async function settleAll<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
}

/** Refuse before any rename, so a directory in one target's place never leaves the others half replaced. */
async function requireFileTargets(targets: readonly string[]): Promise<void> {
  for (const target of targets) {
    const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stats?.isDirectory()) throw Object.assign(new Error(`EISDIR: ${target} is a directory`), { code: "EISDIR" });
  }
}
