// Builds the public site into site/dist: the sandbox at the root and the playground under
// /playground/. Both apps use relative URLs (wasm, workers, service-worker scopes), so they
// work unchanged in either place.
import { appendFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(import.meta.dir, "dist");

async function run(app: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: join(root, app), stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${app}: ${cmd.join(" ")} failed`);
}

async function build(app: string): Promise<void> {
  await run(app, ["bun", "install", "--frozen-lockfile"]);
  await run(app, ["bun", "run", "build"]);
}

// The deployed site always ships bash-web's shell and env guests, built at the apps' pin.
const guests = Bun.spawn(["bash", "scripts/build-bash-web-shell.sh"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if ((await guests.exited) !== 0) throw new Error("scripts/build-bash-web-shell.sh failed");
process.env.BASH_WEB_GUESTS = "required";
await build("sandbox");
await build("web");
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
console.log(`site: ${out}`);
