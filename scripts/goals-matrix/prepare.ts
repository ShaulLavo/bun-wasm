import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pinnedBashWeb, verifiedGuests } from "../bash-web-guests";
import { preflight, preparationOptions, withStagedAssets } from "./preparation";
import { engines } from "./catalog";
import { engineFiles } from "./engines";
import { parseMemoryProfile } from "../../web/src/program-profile";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind";
import { writePreparedSiteInventory } from "./prepared-site";
const { delivery, spidermonkey, shell: selectedShell, profile: requestedProfile } = preparationOptions(process.argv.slice(2));
const profile = parseMemoryProfile(requestedProfile);
const manifest: unknown = JSON.parse(await readFile(resolve(delivery, "../delivery-manifest.json"), "utf8"));
if (!manifest || typeof manifest !== "object" || !("guestSource" in manifest) || !manifest.guestSource || typeof manifest.guestSource !== "object" || !("head" in manifest.guestSource) || typeof manifest.guestSource.head !== "string" || !/^[a-f0-9]{40}$/.test(manifest.guestSource.head)) throw new Error("Delivery manifest has no exact guest source commit");
const guestHead = manifest.guestSource.head;
const spiderMonkeySource: unknown = spidermonkey ? JSON.parse(await readFile(spidermonkey.source, "utf8")) : undefined;
const shell = resolve(selectedShell ?? process.env.BASH_WEB_GUESTS_DIR ?? "dist");
const shellGuests = verifiedGuests(shell, pinnedBashWeb(resolve("web")));
if (!shellGuests && (selectedShell || process.env.BASH_WEB_GUESTS_DIR)) throw new Error("Preparation requires current receipt-backed shell guests through --shell or BASH_WEB_GUESTS_DIR");
const spiderMonkeyFiles: { file: string; bytes: number; sha256: string }[] = [];
await withStagedAssets(join(delivery, "web"), async assets => {
  if (spidermonkey) {
    for (const file of engineFiles("spidermonkey")) {
      const data = await Bun.file(join(assets, file)).bytes();
      spiderMonkeyFiles.push({ file, bytes: data.length, sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex") });
    }
  }
  if (!shellGuests) throw new Error("Preparation requires current receipt-backed shell guests through --shell or BASH_WEB_GUESTS_DIR");
  const guestSource = Bun.spawn(["git", "cat-file", "-e", `${guestHead}^{commit}`], { stderr: "pipe" });
  if (await guestSource.exited !== 0) throw new Error("Delivery guest source commit is unavailable; fetch its original source before preparation");
  const build = Bun.spawn(["bun", "web/build.ts"], { stdout: "inherit", stderr: "inherit", env: { ...process.env,
    BASH_WEB_GUESTS_DIR: resolve(shell), BASH_WEB_GUESTS: "required",
    BUN_WASM: join(assets, "bun.wasm"), JSC_WASM: join(assets, "bun-jsc.wasm"), BUN_BROWSER_WASM: join(assets, "bun-browser.wasm"), BUN_TOOLS_WASM: join(assets, "bun-tools.wasm"),
    SPIDERMONKEY_WASM: await Bun.file(join(assets, "bun-spidermonkey.wasm")).exists() ? join(assets, "bun-spidermonkey.wasm") : undefined,
    SHARED_QUICKJS_PROGRAM: await Bun.file(join(assets, "shared-quickjs/bun.wasm")).exists() ? join(assets, "shared-quickjs") : process.env.SHARED_QUICKJS_PROGRAM,
    SHARED_JSC_PROGRAM: await Bun.file(join(assets, "shared-jsc/bun.wasm")).exists() ? join(assets, "shared-jsc") : process.env.SHARED_JSC_PROGRAM,
  } });
  if (await build.exited !== 0) throw new Error("Playground build failed");
}, { spidermonkey: spidermonkey?.directory });
await preflight(resolve("web/dist"), profile === "shared-group" ? ["quickjs", "jsc"] : engines, profile);

await writeFile(resolve("web/dist/goals-asset-sources.json"), JSON.stringify({
  profile, delivery: { directory: delivery, manifest },
  spidermonkey: spidermonkey ? { ...spidermonkey, origin: spiderMonkeySource, files: spiderMonkeyFiles } : undefined,
  shell: { directory: shell, receipt: JSON.parse(await readFile(join(shell, "bash-web-guests.json"), "utf8")) },
}));

const source = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
const commit = (await new Response(source.stdout).text()).trim();
if (await source.exited !== 0) throw new Error("Cannot identify built host source");
const status = Bun.spawn(["git", "status", "--porcelain"], { stdout: "pipe" });
const dirty = Boolean((await new Response(status.stdout).text()).trim());
if (await status.exited !== 0) throw new Error("Cannot identify built host state");
await writeFile(resolve("web/dist/goals-host-source.json"), JSON.stringify({ commit, dirty, profile, guestSource: manifest.guestSource, shellSource: pinnedBashWeb(resolve("web")), memoryGroups: BUN_MEMORY_GROUP_POLICY, build: "bun web/build.ts" }));
await writePreparedSiteInventory(resolve("web/dist"));
