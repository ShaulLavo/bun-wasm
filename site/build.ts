// Builds the public site into site/dist: the sandbox at the root and the playground under
// /playground/. Both apps use relative URLs (wasm, workers, service-worker scopes), so they
// work unchanged in either place.
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSiteSpiderMonkey, verifySiteGuests } from "../scripts/site-guest-preflight";
import { requireSharedProgramInputs } from "../scripts/stage-program-profiles";
import { brotliQuality } from "../scripts/stage-guest-wasm";
import { templates } from "../sandbox/src/template-catalog";

const root = resolve(import.meta.dir, "..");
const out = join(import.meta.dir, "dist");

async function run(app: string, cmd: string[]): Promise<void> {
  // Bun.spawn does not pass later process.env changes on by itself (BASH_WEB_GUESTS below).
  const proc = Bun.spawn(cmd, { cwd: join(root, app), env: process.env, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${app}: ${cmd.join(" ")} failed`);
}

async function build(app: string): Promise<void> {
  await run(app, ["bun", "install", "--frozen-lockfile"]);
  await run(app, ["bun", "run", "build"]);
}

// Deployed guests ship Brotli quality 11 unless overridden; an invalid override fails before any build starts.
process.env.BUN_WASM_BROTLI_QUALITY ??= "11";
brotliQuality();
// The site copies sandbox/dist and web/dist, so the app builds must write there.
delete process.env.BUN_WASM_APP_OUT;
const spiderMonkey = resolveSiteSpiderMonkey(root);
await verifySiteGuests(root, process.env, spiderMonkey);
// The public site never ships a guest with debug names. Set the profiling override to "0"
// instead of deleting it: a variable the app builds find unset could be loaded from their own
// .env files, while an explicit value wins (scripts/wasm-name-sections.ts).
process.env.BUN_WASM_KEEP_NAMES = "0";
requireSharedProgramInputs(spiderMonkey ? ["quickjs", "jsc", "spidermonkey"] : ["quickjs", "jsc"]);
if (spiderMonkey) process.env.SPIDERMONKEY_WASM = spiderMonkey;

// The deployed site always ships bash-web's shell and env guests, built at the apps' pin.
const guests = Bun.spawn(["bash", "scripts/build-bash-web-shell.sh"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if ((await guests.exited) !== 0) throw new Error("scripts/build-bash-web-shell.sh failed");
process.env.BASH_WEB_GUESTS = "required";
// Quality 11 is about 13% smaller than the quick default (scripts/stage-guest-wasm.ts). Both apps
// stage the same guests, so they share one cache.
const compressionCache = mkdtempSync(join(tmpdir(), "bun-wasm-site-brotli-"));
process.env.BUN_WASM_COMPRESSION_CACHE = compressionCache;
try {
  await build("sandbox");
  await build("web");
} finally {
  rmSync(compressionCache, { recursive: true, force: true });
}
rmSync(out, { recursive: true, force: true });
cpSync(join(root, "sandbox/dist"), out, { recursive: true });
cpSync(join(root, "web/dist"), join(out, "playground"), { recursive: true });
rmSync(join(out, "playground/_headers"));
// Cloudflare allows one splat per rule, so the playground's hashed-chunk rules are spelled out.
const immutable = "  Cache-Control: public, max-age=31536000, immutable\n";
appendFileSync(join(out, "_headers"), "\n/playground/\n  Cache-Control: no-store\n/playground/index.html\n  Cache-Control: no-store\n"
  + `/playground/chunks/*.js\n${immutable}/playground/__bunwasm/chunks/*.js\n${immutable}`);
// Source maps stay local; the public site doesn't need them.
for (const map of new Bun.Glob("**/*.map").scanSync(out)) rmSync(join(out, map));
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
if (revision.exitCode !== 0) throw new Error("Cannot identify the site source commit");
const waffle = await Bun.file(join(root, "sandbox/node_modules/waffle/package.json")).json();
await Bun.write(join(out, "deployment.json"), JSON.stringify({
  sourceCommit: revision.stdout.toString().trim(),
  waffleVersion: waffle.version,
  templates: templates.map(({ id, label, file, editorFile }) => ({ id, label, file, editorFile })),
}, null, 2));
console.log(`site: ${out}`);
