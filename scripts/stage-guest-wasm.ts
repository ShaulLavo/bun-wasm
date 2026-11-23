import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { replaceFiles, settleAll, type Writer } from "./stage-wasm-sidecars";
import { assertShippedGuestHasNoNames, keepNamesRequested } from "./wasm-name-sections";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/**
 * Stage one guest for a site build: check that it ships no debug names, write `<name>.br` and
 * `<name>.gz` into `out`, then record its hash in `builds`. No raw file ships: static hosts cap file
 * sizes (Cloudflare: 25 MiB; jsc-engine.wasm is 34 MB raw). Negotiating hosts (site/worker.ts,
 * web/serve.ts) answer the logical `<name>` URL with a twin and a native Content-Encoding; plain
 * hosts serve the `.gz` twin, which the page decompresses (web/src/engine-loader.ts).
 */
export async function stageGuestWasm(source: string, name: string, out: string, builds: Record<string, string>, write: Writer = writeFile): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  assertShippedGuestHasNoNames(name, bytes, keepNamesRequested());
  const digest = sha256(bytes);
  await writeGuestTwins(join(out, name), bytes, digest, write);
  builds[name] = digest;
}

/** Guests stage concurrently, so their digests are recorded in completion order. Sort them for stable output. */
export function sortedBuilds(builds: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(builds).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0));
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Write `<path>.gz` and `<path>.br` for the guest whose SHA-256 is `digest`. Both land in temporary
 * files and replace the targets only after both writes succeeded, so a failure never leaves one twin
 * of a guest without the other.
 */
export async function writeGuestTwins(path: string, bytes: Uint8Array, digest: string, write: Writer = writeFile): Promise<void> {
  const quality = brotliQuality();
  const gz = gzipped(bytes, { level: 9 });
  const br = brotliTwin(bytes, digest, quality);
  await settleAll([gz, br]);
  await replaceFiles([[`${path}.gz`, await gz], [`${path}.br`, await br]], write);
}

/**
 * Brotli quality for guest twins. Quality 11 is about 13% smaller than quality 5 on the guests but
 * takes 25 to 45 s per guest instead of 0.3 s, so only site deploys ask for it (site/build.ts);
 * ordinary builds stay faster than their gzip -9 twin.
 */
export function brotliQuality(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.BUN_WASM_BROTLI_QUALITY?.trim();
  if (!value) return 5;
  const quality = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(quality >= constants.BROTLI_MIN_QUALITY && quality <= constants.BROTLI_MAX_QUALITY)) {
    throw new Error(`BUN_WASM_BROTLI_QUALITY must be an integer from 0 to 11, got ${JSON.stringify(env.BUN_WASM_BROTLI_QUALITY)}`);
  }
  return quality;
}

/**
 * The Brotli twin. BUN_WASM_COMPRESSION_CACHE names a directory that keeps twins by input digest
 * and quality, so the sandbox and playground builds of one site deploy compress each guest once.
 */
async function brotliTwin(bytes: Uint8Array, digest: string, quality: number): Promise<Uint8Array> {
  const cache = process.env.BUN_WASM_COMPRESSION_CACHE;
  const entry = cache ? join(cache, `${digest}.q${quality}.br`) : undefined;
  if (entry && await Bun.file(entry).exists()) return Bun.file(entry).bytes();
  const params = {
    [constants.BROTLI_PARAM_QUALITY]: quality,
    // At quality 10 and 11 the largest window browsers decode saves about 1.5% on the 23 MB tools
    // guest; at lower qualities it makes the Browser guest about 3% larger, so they keep the default.
    [constants.BROTLI_PARAM_LGWIN]: quality >= 10 ? constants.BROTLI_MAX_WINDOW_BITS : constants.BROTLI_DEFAULT_WINDOW,
    [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
  };
  const br = await brotli(bytes, { params });
  // A crashed or concurrent writer never leaves a partial cache entry under the final name.
  if (entry) await replaceFiles([[entry, br]]);
  return br;
}
