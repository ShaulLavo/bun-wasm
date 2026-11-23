import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/**
 * Write a raw program WASM plus `.br` and `.gz` twins. Hosts pick one by Accept-Encoding and send it
 * with a native Content-Encoding (site/worker.ts, web/serve.ts), so a plain fetch of the logical URL
 * gets the smaller download. Brotli quality 11 costs about 3 s on the 2.3 MB shell guest and cuts
 * its wire size by about a quarter compared with Cloudflare's on-the-fly Brotli.
 */
export async function writeWasmWithSidecars(path: string, bytes: Uint8Array): Promise<void> {
  const [br, gz] = await Promise.all([
    brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } }),
    gzipped(bytes, { level: 9 }),
  ]);
  await Promise.all([Bun.write(path, bytes), Bun.write(`${path}.br`, br), Bun.write(`${path}.gz`, gz)]);
}
