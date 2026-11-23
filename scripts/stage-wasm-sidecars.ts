import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

type Writer = (path: string, bytes: Uint8Array) => Promise<void>;

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
  const outputs: [string, Uint8Array][] = [[path, bytes], [`${path}.gz`, gz], [`${path}.br`, br]];
  const suffix = `.${process.pid}-${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await Promise.all(outputs.map(([target, data]) => write(target + suffix, data)));
  } catch (error) {
    await Promise.all(outputs.map(([target]) => rm(target + suffix, { force: true })));
    throw error;
  }
  for (const [target] of outputs) await rename(target + suffix, target);
}
