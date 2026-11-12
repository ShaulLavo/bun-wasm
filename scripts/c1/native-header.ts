import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { captureProgramInputs } from "../guest-core-receipt.ts";
import { sourceOptions } from "../guest-source-manifest.ts";
import { parseInputManifest } from "./contract.ts";
import { requireNativeGroups } from "./publication.ts";

/**
 * Preclaim native header admission, run as an owned child in the sourced
 * environment from the selected source: the JSC component inputs this source
 * captures must equal the original header manifest's native groups. Reads only.
 *
 *   bun scripts/c1/native-header.ts INPUT_MANIFEST.json
 */
if (import.meta.main) {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error("Usage: bun scripts/c1/native-header.ts INPUT_MANIFEST.json");
  const manifest = parseInputManifest(JSON.parse(readFileSync(resolve(path), "utf8")));
  const component = await captureProgramInputs(sourceOptions(process.cwd(), manifest.native.sysroot.root, "jsc"), "jsc");
  const header = requireNativeGroups(manifest, [component]);
  process.stdout.write(`native header groups match ${header.path}\n`);
}
