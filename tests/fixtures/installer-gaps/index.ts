import { mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const accept = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const requests: string[] = [];
let latest = "1.0.0";
function tar(files: Record<string, string>) {
  const chunks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text);
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
    put(0, `package/${name}`);
    put(100, "0000755\0");
    put(124, bytes.length.toString(8).padStart(11, "0") + "\0");
    header[156] = 48;
    put(257, "ustar\0");
    header.fill(32, 148, 156);
    put(148, header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ");
    chunks.push(header, bytes, new Uint8Array((512 - bytes.length % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return Bun.gzipSync(bytes);
}
const archives = new Map<string, Uint8Array>();
for (const version of ["1.0.0", "1.1.0", "2.0.0"]) {
  archives.set(version, tar({
    "package.json": JSON.stringify({ name: "fixture-cli", version, bin: { "fixture-cli": "cli.ts" } }),
    "cli.ts": `#!/usr/bin/env node\nconsole.log("fixture-${version}", process.argv.slice(2).join("|"));\n`,
  }));
}
const server = Bun.serve({ port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  requests.push(path);
  const archive = archives.get(path.slice(1).replace(/\.tgz$/, ""));
  if (archive) return new Response(archive);
  if (path !== "/fixture-cli") return new Response("missing", { status: 404 });
  if (req.headers.get("accept") !== accept) return new Response("wrong Accept", { status: 400 });
  return Response.json({ name: "fixture-cli", "dist-tags": { latest }, versions: Object.fromEntries(
    Array.from(archives, ([version, bytes]) => [version, { name: "fixture-cli", version, bin: { "fixture-cli": "cli.ts" },
      dist: { tarball: `${server.url}${version}.tgz`, integrity: `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}` } }]),
  ) });
} });
async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env: { ...process.env,
    NPM_CONFIG_REGISTRY: String(server.url), BUN_INSTALL_CACHE_DIR: join(process.cwd(), "cache"),
  }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  if (code) throw new Error(`${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}
function project(name: string, files: Record<string, unknown>) {
  const cwd = join(process.cwd(), name);
  for (const [path, data] of Object.entries(files)) {
    const file = join(cwd, path);
    mkdirSync(join(file, ".."), { recursive: true });
    require("node:fs").writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  }
  return cwd;
}
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
const cases: Record<string, () => Promise<void>> = {
  async workspaces() {
    const cwd = project("workspace", { "package.json": { name: "root", workspaces: ["packages/*"], dependencies: { a: "workspace:*" } },
      "packages/a/package.json": { name: "a", version: "1.0.0", main: "index.ts", dependencies: { b: "workspace:^" } },
      "packages/a/index.ts": 'import { value } from "b"; console.log(value);',
      "packages/b/package.json": { name: "b", version: "1.0.0", main: "index.ts" },
      "packages/b/index.ts": 'export const value = "workspace-ok";',
    });
    await run(cwd, "install");
    check((await run(cwd, "run", "packages/a/index.ts")).trim() === "workspace-ok", "workspace graph");
    await run(cwd, "install", "--frozen-lockfile");
    await run(join(cwd, "packages/a"), "install", "--frozen-lockfile");
  },
  async registry() {
    const cwd = project("registry", { "package.json": { dependencies: { "fixture-cli": "^1.0.0" } } });
    await run(cwd, "install");
    check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "1.1.0", "registry install");
  },
  async binaries() {
    const cwd = join(process.cwd(), "registry");
    check(existsSync(join(cwd, "node_modules/.bin/fixture-cli")), "binary link missing");
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    pkg.scripts = { dev: 'fixture-cli "two words"' };
    require("node:fs").writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg));
    check((await run(cwd, "run", "dev", "tail")).trim() === "fixture-1.1.0 two words|tail", "package script binary");
    check((await run(cwd, "run", "fixture-cli", "direct")).trim() === "fixture-1.1.0 direct", "direct binary");
  },
  async update() {
    const cwd = project("update", { "package.json": { dependencies: { "fixture-cli": "^1.0.0" } } });
    await run(cwd, "install");
    latest = "2.0.0";
    await run(cwd, "update");
    check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "1.1.0", "update range");
    await run(cwd, "update", "fixture-cli", "--latest");
    check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "2.0.0", "update latest");
  },
  async migration() {
    const cwd = project("migrate", { "package.json": { dependencies: { "fixture-cli": "^1.0.0" } },
      "package-lock.json": { lockfileVersion: 3, packages: { "": { dependencies: { "fixture-cli": "^1.0.0" } },
        "node_modules/fixture-cli": { version: "1.0.0", resolved: `${server.url}1.0.0.tgz`,
          integrity: `sha512-${new Bun.CryptoHasher("sha512").update(archives.get("1.0.0")!).digest("base64")}`, bin: { "fixture-cli": "cli.ts" } } } },
    });
    await run(cwd, "install");
    check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "1.0.0", "migration must retain pin");
  },
  async bunx() {
    const cwd = join(process.cwd(), "registry");
    check((await run(cwd, "x", "fixture-cli", "local")).trim() === "fixture-1.1.0 local", "bun x local");
    const empty = project("bunx", { "package.json": {} });
    check((await run(empty, "x", "fixture-cli@1.0.0", "remote")).trim() === "fixture-1.0.0 remote", "bun x install");
    check(!existsSync(join(empty, "bun.lock")), "bun x changed project lock");
  },
};
try {
  for (const [name, fn] of Object.entries(cases)) {
    try { await fn(); console.log(`${name} ok`); }
    catch (error) { console.log(`${name} failed`); console.error(String(error)); process.exitCode = 1; }
  }
} finally { server.stop(true); }
