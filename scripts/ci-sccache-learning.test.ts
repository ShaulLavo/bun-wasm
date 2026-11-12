import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureObjects, planObjects } from "./ci-sccache-cache";

const repository = resolve(import.meta.dir, "..");

function cacheBinary(): string {
  const binary = Bun.which("sccache");
  if (!binary) throw new Error("Install pinned sccache before running the native probe");
  return binary;
}

function count(output: string, name: string): number {
  const value = new RegExp(`^${name}\\s+(\\d+)\\s*$`, "m").exec(output)?.[1];
  if (value === undefined) throw new Error(`Missing ${name}: ${output}`);
  return Number(value);
}

function compile(root: string) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("SCCACHE_")));
  const env: NodeJS.ProcessEnv = { ...inherited, BUILD_CACHE: "1", SCCACHE_DIR: join(root, "cache"), SCCACHE_SOCKET_ROOT: root, SCCACHE_CACHE_SIZE: "512M" };
  const result = spawnSync("bash", [join(repository, "scripts/with-build-cache.sh"), cacheBinary(), "rustc", "--crate-name", "cache_learning",
    "--crate-type", "rlib", join(root, "source.rs"), "--out-dir", root, "--emit=dep-info,link"], { cwd: repository, env, encoding: "utf8", timeout: 15_000 });
  const output = result.stdout + result.stderr;
  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).not.toContain("couldn't connect to server");
  const hits = count(output, "Cache hits"), misses = count(output, "Cache misses");
  expect(hits + misses, output).toBe(1);
  return { hits, misses, rate: hits / (hits + misses) };
}

async function restore(root: string, archive: string) {
  await rm(join(root, "cache"), { recursive: true, force: true });
  await rm(join(root, "libcache_learning.rlib"), { force: true });
  await cp(archive, join(root, "cache"), { recursive: true });
}

async function stopOwnedServers(root: string) {
  const sockets = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith("sc."));
  for (const socket of sockets) {
    spawnSync(cacheBinary(), ["--stop-server"], { env: { ...process.env, SCCACHE_SERVER_UDS: join(root, socket.name, "server") }, timeout: 5000, stdio: "ignore" });
  }
}

test("new compiler objects survive a learned snapshot but not the old immutable seed policy", async () => {
  expect(Bun.which("sccache"), "Install pinned sccache before running the native probe").not.toBeNull();
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-sccache-learn-"));
  const initial = join(root, "initial.json"), seed = join(root, "seed"), learned = join(root, "learned");
  try {
    await mkdir(join(root, "cache"));
    await writeFile(join(root, "source.rs"), "pub fn answer() -> u32 { 11 }\n");
    expect(compile(root)).toEqual({ hits: 0, misses: 1, rate: 0 });
    await cp(join(root, "cache"), seed, { recursive: true });
    await captureObjects(join(root, "cache"), initial);
    await writeFile(join(root, "source.rs"), "pub fn answer() -> u32 { 29 }\n");
    expect(compile(root)).toEqual({ hits: 0, misses: 1, rate: 0 });
    const plan = await planObjects(join(root, "cache"), initial);
    expect(plan).toMatchObject({ changed: true, fits: true });
    await cp(join(root, "cache"), learned, { recursive: true });
    const expectedOutput = createHash("sha256").update(await readFile(join(root, "libcache_learning.rlib"))).digest("hex");
    await restore(root, seed);
    const before = compile(root);
    expect(before).toEqual({ hits: 0, misses: 1, rate: 0 });
    await restore(root, learned);
    await captureObjects(join(root, "cache"), initial);
    const after = compile(root);
    expect(after).toEqual({ hits: 1, misses: 0, rate: 1 });
    expect(createHash("sha256").update(await readFile(join(root, "libcache_learning.rlib"))).digest("hex")).toBe(expectedOutput);
    expect(await planObjects(join(root, "cache"), initial)).toMatchObject({ changed: false, fits: true });
    expect((await readdir(root)).filter(name => name.startsWith("sc."))).toEqual([]);
    console.log(JSON.stringify({ measurement: "real-rust-object-learning-round-trip", compiler: "rustc", before, after,
      scope: "controlled new-object restoration; not a production build speedup" }));
  } finally {
    await stopOwnedServers(root);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
