import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt";
import { guestBuilds } from "./guest-source-manifest";

const guests = [
  { name: "bun-browser.wasm", variable: "BUN_BROWSER_WASM" },
  { name: "bun.wasm", variable: "BUN_WASM" },
  { name: "bun-jsc.wasm", variable: "JSC_WASM" },
  { name: "bun-tools.wasm", variable: "BUN_TOOLS_WASM" },
] as const;

export async function verifySiteGuests(repository: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const guest of guests) {
    const path = resolve(repository, "sandbox", env[guest.variable] ?? `../dist/${guest.name}`);
    const receipt: unknown = JSON.parse(await readFile(`${path}.build.json`, "utf8"));
    verifyGuestBuildReceipt(await readFile(path), receipt);
    if (guestBuilds[receipt.sourceManifest.build].artifact !== guest.name) throw new Error(`Site guest engine mismatch: ${path}`);
    await verifyGuestCompanions(receipt, dirname(path));
  }
}

if (import.meta.main) await verifySiteGuests(resolve(import.meta.dir, ".."));
