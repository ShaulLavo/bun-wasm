import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pinnedBashWeb, verifiedGuests } from "../bash-web-guests";
import { preflight, withStagedAssets } from "./preparation";
import { engines } from "./catalog";
import { parseMemoryProfile } from "../../web/src/program-profile";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind";
import { writePreparedSiteInventory } from "./prepared-site";
const delivery = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/goals-matrix/prepare.ts /absolute/delivery");
const profileArgument = process.argv[3];
if (process.argv.length > 4 || (profileArgument && !profileArgument.startsWith("--profile="))) throw new Error("Expected optional --profile=split|shared-group");
const profile = parseMemoryProfile(profileArgument?.slice("--profile=".length));
const manifest: unknown = JSON.parse(await readFile(resolve(delivery, "../delivery-manifest.json"), "utf8"));
if (!manifest || typeof manifest !== "object" || !("guestSource" in manifest) || !manifest.guestSource || typeof manifest.guestSource !== "object" || !("head" in manifest.guestSource) || typeof manifest.guestSource.head !== "string" || !/^[a-f0-9]{40}$/.test(manifest.guestSource.head)) throw new Error("Delivery manifest has no exact guest source commit");
const guestSource = Bun.spawn(["git", "cat-file", "-e", `${manifest.guestSource.head}^{commit}`], { stderr: "pipe" });
if (await guestSource.exited !== 0) throw new Error("Delivery guest source commit is unavailable; fetch its original source before preparation");
await withStagedAssets(join(delivery, "web"), async assets => {
  const shell = process.env.BASH_WEB_GUESTS_DIR;
  if (!shell || !verifiedGuests(shell, pinnedBashWeb(resolve("web")))) throw new Error("Preparation requires BASH_WEB_GUESTS_DIR with the current pinned shell's original receipt and matching bytes");
  const build = Bun.spawn(["bun", "web/build.ts"], { stdout: "inherit", stderr: "inherit", env: { ...process.env,
    BASH_WEB_GUESTS_DIR: resolve(shell), BASH_WEB_GUESTS: "required",
    BUN_WASM: join(assets, "bun.wasm"), JSC_WASM: join(assets, "bun-jsc.wasm"), BUN_BROWSER_WASM: join(assets, "bun-browser.wasm"), BUN_TOOLS_WASM: join(assets, "bun-tools.wasm"),
    SPIDERMONKEY_WASM: await Bun.file(join(assets, "bun-spidermonkey.wasm")).exists() ? join(assets, "bun-spidermonkey.wasm") : undefined,
    SHARED_QUICKJS_PROGRAM: await Bun.file(join(assets, "shared-quickjs/bun.wasm")).exists() ? join(assets, "shared-quickjs") : process.env.SHARED_QUICKJS_PROGRAM,
    SHARED_JSC_PROGRAM: await Bun.file(join(assets, "shared-jsc/bun.wasm")).exists() ? join(assets, "shared-jsc") : process.env.SHARED_JSC_PROGRAM,
  } });
  if (await build.exited !== 0) throw new Error("Playground build failed");
});
await preflight(resolve("web/dist"), profile === "shared-group" ? ["quickjs", "jsc"] : engines, profile);

const source = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
const commit = (await new Response(source.stdout).text()).trim();
if (await source.exited !== 0) throw new Error("Cannot identify built host source");
const status = Bun.spawn(["git", "status", "--porcelain"], { stdout: "pipe" });
const dirty = Boolean((await new Response(status.stdout).text()).trim());
if (await status.exited !== 0) throw new Error("Cannot identify built host state");
await writeFile(resolve("web/dist/goals-host-source.json"), JSON.stringify({ commit, dirty, profile, guestSource: manifest.guestSource, shellSource: pinnedBashWeb(resolve("web")), memoryGroups: BUN_MEMORY_GROUP_POLICY, build: "bun web/build.ts" }));
await writePreparedSiteInventory(resolve("web/dist"));
