import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pinnedBashWeb } from "../bash-web-guests";
import { preflight, withStagedAssets } from "./preparation";
const delivery = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/goals-matrix/prepare.ts /absolute/delivery");
const manifest: unknown = JSON.parse(await readFile(resolve(delivery, "../delivery-manifest.json"), "utf8"));
if (!manifest || typeof manifest !== "object" || !("guestSource" in manifest) || !manifest.guestSource || typeof manifest.guestSource !== "object" || !("head" in manifest.guestSource) || typeof manifest.guestSource.head !== "string" || !/^[a-f0-9]{40}$/.test(manifest.guestSource.head)) throw new Error("Delivery manifest has no exact guest source commit");
const sourcePackage = Bun.spawn(["git", "show", `${manifest.guestSource.head}:web/package.json`], { stdout: "pipe", stderr: "inherit" });
const original: unknown = JSON.parse(await new Response(sourcePackage.stdout).text());
if (await sourcePackage.exited !== 0 || !original || typeof original !== "object" || !("dependencies" in original) || !original.dependencies || typeof original.dependencies !== "object" || !("bash-web" in original.dependencies) || !String(original.dependencies["bash-web"]).endsWith("#" + pinnedBashWeb(resolve("web")))) throw new Error("Delivery shell pin differs from current playground; build matching shell guests instead");
await withStagedAssets(join(delivery, "web"), async assets => {
  const build = Bun.spawn(["bun", "web/build.ts"], { stdout: "inherit", stderr: "inherit", env: { ...process.env,
    BUN_WASM: join(assets, "bun.wasm"), JSC_WASM: join(assets, "bun-jsc.wasm"), BUN_BROWSER_WASM: join(assets, "bun-browser.wasm"), BUN_TOOLS_WASM: join(assets, "bun-tools.wasm"),
  } });
  if (await build.exited !== 0) throw new Error("Playground build failed");
});
await cp(join(delivery, "web/programs"), resolve("web/dist/programs"), { recursive: true });
await preflight(resolve("web/dist"), ["browser", "quickjs", "jsc"]);

const source = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
const commit = (await new Response(source.stdout).text()).trim();
if (await source.exited !== 0) throw new Error("Cannot identify built host source");
const status = Bun.spawn(["git", "status", "--porcelain"], { stdout: "pipe" });
const dirty = Boolean((await new Response(status.stdout).text()).trim());
if (await status.exited !== 0) throw new Error("Cannot identify built host state");
await writeFile(resolve("web/dist/goals-host-source.json"), JSON.stringify({ commit, dirty, build: "bun web/build.ts" }));
