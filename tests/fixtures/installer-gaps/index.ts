import { mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const accept = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const requests: string[] = [];
let latest = "1.0.0";
let checkAccept = false;
let omitIntegrity = false;
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
  requests.push(`${latest}:${path}`);
  const archive = archives.get(path.slice(1).replace(/\.tgz$/, ""));
  if (archive) return new Response(archive);
  if (path !== "/fixture-cli") return new Response("missing", { status: 404 });
  if (checkAccept && req.headers.get("accept") !== accept) return new Response("wrong Accept", { status: 400 });
  return Response.json({ name: "fixture-cli", "dist-tags": { latest }, versions: Object.fromEntries(
    Array.from(archives, ([version, bytes]) => [version, { name: "fixture-cli", version, bin: { "fixture-cli": "cli.ts" },
      dist: { tarball: `${server.url}${version}.tgz`, ...(omitIntegrity ? {} : { integrity: `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}` }) } }]),
  ) });
} });
async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env: { ...process.env,
    NPM_CONFIG_REGISTRY: String(server.url), BUN_INSTALL_CACHE_DIR: join(cwd, ".cache"),
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
    const cwd = project("workspace", { "package.json": { name: "root", workspaces: ["packages/*"], dependencies: { a: "workspace:*", "fixture-cli": "1.0.0" } },
      "packages/a/package.json": { name: "a", version: "1.0.0", main: "index.ts", dependencies: { b: "workspace:^", plain: "link:./plain" } },
      "packages/a/index.ts": 'import { value } from "b"; import plain from "plain"; console.log(value + plain);',
      "packages/a/plain/index.js": 'module.exports = "-linked";',
      "packages/b/package.json": { name: "b", version: "1.0.0", main: "index.ts" },
      "packages/b/index.ts": 'export const value = "workspace-ok";',
    });
    await run(cwd, "install");
    check((await run(cwd, "run", "packages/a/index.ts")).trim() === "workspace-ok-linked", "workspace graph");
    await run(cwd, "install", "--frozen-lockfile");
    await run(join(cwd, "packages/a"), "install", "--frozen-lockfile");
    latest = "2.0.0";
    const added = await run(join(cwd, "packages/a"), "add", "fixture-cli");
    latest = "1.0.0";
    const member = JSON.parse(readFileSync(join(cwd, "packages/a/package.json"), "utf8"));
    check(member.dependencies["fixture-cli"] === "^2.0.0", `workspace add writes member resolution: ${JSON.stringify({ member, added, requests })}`);
    check(member.devDependencies === undefined && member.optionalDependencies === undefined && member.peerDependencies === undefined, "adding a dependency inserted absent groups");
    check(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).dependencies["fixture-cli"] === "1.0.0", "workspace add changed root");
  },
  async registry() {
    const cwd = project("registry", { "package.json": { dependencies: { "fixture-cli": "^1.0.0" } } });
    checkAccept = true;
    try { await run(cwd, "install"); } finally { checkAccept = false; }
    check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "1.1.0", "registry install");
  },
  async binaries() {
    const cwd = project("binary", { "package.json": { dependencies: { "fixture-cli": "^1.0.0" } } });
    await run(cwd, "install");
    check(existsSync(join(cwd, "node_modules/.bin/fixture-cli")), "binary link missing");
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    pkg.scripts = { dev: 'fixture-cli "two words"' };
    require("node:fs").writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg));
    check((await run(cwd, "run", "dev", "tail")).trim() === "fixture-1.1.0 two words|tail", "package script binary");
    check((await run(cwd, "run", "fixture-cli", "direct")).trim() === "fixture-1.1.0 direct", "direct binary");
    symlinkSync("../fixture-cli/cli.ts", join(cwd, "node_modules/.bin/constructor"));
    check((await run(cwd, "run", "constructor", "proto")).trim() === "fixture-1.1.0 proto", "inherited script property masked a binary");
  },
  async update() {
    const cwd = project("update", { "package.json": { dependencies: { "fixture-cli": "1.0.0" } } });
    await run(cwd, "install");
    require("node:fs").writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { "fixture-cli": "^1.0.0" } }));
    latest = "2.0.0";
    await run(cwd, "update");
    check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "1.1.0", "update range");
    await run(cwd, "update", "fixture-cli", "--latest");
    check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "2.0.0", "update latest");
  },
  async migration() {
    const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archives.get("1.0.0")!).digest("base64")}`;
    const dep = { version: "1.0.0", resolved: `${server.url}1.0.0.tgz`, integrity, bin: { "fixture-cli": "cli.ts" } };
    const locks: Record<string, unknown> = {
      "package-lock.json": { lockfileVersion: 3, packages: { "": { dependencies: { "fixture-cli": "^1.0.0" } }, "node_modules/fixture-cli": dep } },
      "yarn.lock": `"fixture-cli@^1.0.0":\n  version "1.0.0"\n  resolved "${server.url}1.0.0.tgz"\n  integrity ${integrity}\n`,
      "pnpm-lock.yaml": `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture-cli:\n        specifier: ^1.0.0\n        version: 1.0.0\npackages:\n  fixture-cli@1.0.0:\n    resolution:\n      integrity: ${integrity}\n      tarball: ${server.url}1.0.0.tgz\nsnapshots:\n  fixture-cli@1.0.0: {}\n`,
      "berry/yarn.lock": `__metadata:\n  version: 8\n"fixture-cli@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "fixture-cli@npm:1.0.0"\n`,
    };
    for (const [lockfile, data] of Object.entries(locks)) {
      const cwd = project(`migrate-${lockfile.split("/")[0]}`, { "package.json": { dependencies: { "fixture-cli": "^1.0.0" } }, [lockfile.replace("berry/", "")]: data });
      if (lockfile.startsWith("berry/")) {
        await run(cwd, "install", "--lockfile-only");
        check(readFileSync(join(cwd, "bun.lock"), "utf8").includes("fixture-cli@1.0.0"), "berry migration pin");
      } else {
        await run(cwd, "install");
        check(JSON.parse(readFileSync(join(cwd, "node_modules/fixture-cli/package.json"), "utf8")).version === "1.0.0", "migration must retain pin");
      }
    }
  },
  async bunx() {
    const cwd = join(process.cwd(), "binary");
    omitIntegrity = true;
    check((await run(cwd, "x", "fixture-cli", "local")).trim() === "fixture-1.1.0 local", "bun x local");
    const empty = project("bunx", { "package.json": {} });
    check((await run(empty, "x", "fixture-cli@1.0.0", "remote")).trim() === "fixture-1.0.0 remote", "bun x install");
    check(!existsSync(join(empty, "bun.lock")), "bun x changed project lock");
    const alias = Bun.spawn(["bunx", "fixture-cli", "alias"], { cwd, stdout: "pipe", stderr: "pipe" });
    const [aliasOutput, aliasError, aliasCode] = await Promise.all([alias.stdout.text(), alias.stderr.text(), alias.exited]);
    check(aliasCode === 0 && aliasOutput.trim() === "fixture-1.1.0 alias", `bunx alias: ${aliasError}`);
    const raceCwd = project("bunx-race", { "package.json": {} });
    const raced = await Promise.all(Array.from({ length: 3 }, () => run(raceCwd, "x", "fixture-cli@2.0.0", "race")));
    check(raced.every(output => output.trim() === "fixture-2.0.0 race"), "concurrent bun x install");
  },
};
try {
  for (const [name, fn] of Object.entries(cases)) {
    try { await fn(); console.log(`${name} ok`); }
    catch (error) { console.log(`${name} failed`); console.error(String(error)); process.exitCode = 1; }
  }
} finally { server.stop(true); }
