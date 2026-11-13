import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { object, string } from "./input";
import { ownedCommand, withSignals } from "../goals-matrix/lifetime";
import { verifyPreparedSiteInventory, writePreparedSiteInventory } from "../goals-matrix/prepared-site";

async function prepareLifecycle(canonical: string, scratch: string, spidermonkey: { directory: string; source: string }): Promise<void> {
  const shell = process.env.BASH_WEB_GUESTS_DIR;
  if (!shell) throw new Error("Set BASH_WEB_GUESTS_DIR to current receipt-backed shell guests before preparing a lifecycle host");
  const manifest = object(JSON.parse(await readFile(join(canonical, "MANIFEST.json"), "utf8")));
  const guestSource = object(manifest.originalSource);
  const stage = join(scratch, "delivery-adapter");
  await mkdir(stage);
  try {
    await cp(join(canonical, "site"), join(stage, "delivery/web"), { recursive: true });
    await writeFile(join(stage, "delivery-manifest.json"), JSON.stringify({ guestSource, canonicalManifest: manifest }));
    await withSignals(signal => ownedCommand([process.execPath, "scripts/goals-matrix/prepare.ts", join(stage, "delivery"),
      "--profile=split", `--shell=${resolve(shell)}`, `--spidermonkey=${spidermonkey.directory}`, `--spidermonkey-source=${spidermonkey.source}`], signal, 180_000, true));
    await cp("web/dist", join(scratch, "host"), { recursive: true });
    await verifyPreparedSiteInventory(join(scratch, "host"));
    const waffle = object(JSON.parse(await readFile("web/node_modules/waffle/package.json", "utf8")));
    if (waffle.version !== "0.0.126") throw new Error("Lifecycle host requires Waffle 0.0.126");
    await writeFile(join(scratch, "host/lifecycle-host.json"), JSON.stringify({ waffle: waffle.version, canonicalManifest: manifest,
      guestSource: string(guestSource.head), hostSource: JSON.parse(await readFile("web/dist/goals-host-source.json", "utf8")) }));
    await writePreparedSiteInventory(join(scratch, "host"));
    await verifyPreparedSiteInventory(join(scratch, "host"));
  } finally {
    await ownedCommand(["chmod", "-R", "u+w", stage]);
    await rm(stage, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [canonical, scratch, directory, source] = process.argv.slice(2);
  if (!canonical || !scratch || !directory || !source) throw new Error("Usage: prepare-lifecycle.ts CANONICAL_DELIVERY OWNED_EMPTY_SCRATCH SPIDERMONKEY_PAIR SPIDERMONKEY_SOURCE");
  await prepareLifecycle(resolve(canonical), resolve(scratch), { directory: resolve(directory), source: resolve(source) });
}
