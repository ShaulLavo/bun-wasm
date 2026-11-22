import { join } from "node:path";
import { assertShippedGuestHasNoNames, keepNamesRequested } from "./wasm-name-sections";

/**
 * Stage one guest for a site build: check that it ships no debug names, record its hash in
 * `builds`, and write `<name>.gz` into `out`. Only the .gz ships; the page decompresses it and
 * static hosts cap file sizes (Cloudflare: 25 MiB; bun-jsc.wasm is 43 MB raw, 12 MB gzipped).
 */
export async function stageGuestWasm(source: string, name: string, out: string, builds: Record<string, string>): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  assertShippedGuestHasNoNames(name, bytes, keepNamesRequested());
  builds[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(bytes, { level: 9 }));
}
