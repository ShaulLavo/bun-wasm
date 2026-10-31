import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import release from "./waffle-release-inputs.json";
import { assertExactHostInterface, packageHostInterface, parseHostInterface } from "./waffle-release-inputs";
import { writeInstalledWaffleFixture } from "./fixtures/waffle-host-interface";
import { assertInstalledWaffle, waffleCommits } from "../tests/shell-product/waffle-stage";
import { bundleConsumer, installConsumer } from "../web/tests/shell-consumer-install";

const invalid = [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", true, [], {}];
const required = parseHostInterface(release.hostInterface, "fixture inputs");
const historical = "git+https://github.com/ShaulLavo/waffle.git#c1cb67c300439af24335d0b2ec481bfb52f79a01";

async function withInstallation(run: (root: string, fixture: Awaited<ReturnType<typeof writeInstalledWaffleFixture>>) => Promise<void>, selected = release.url) {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-host-interface-"));
  try { await run(root, await writeInstalledWaffleFixture(root, selected)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const value of invalid.concat([NaN, Infinity, -Infinity])) {
  test(`host interface parser rejects ${String(value)} without coercion`, () => {
    expect(() => parseHostInterface(value, "fixture")).toThrow("waffleHostInterface must be a positive safe integer");
  });
}

test("the parser accepts the full positive safe-integer domain and equality is exact", () => {
  expect(Number(parseHostInterface(Number.MAX_SAFE_INTEGER, "fixture"))).toBe(Number.MAX_SAFE_INTEGER);
  expect(packageHostInterface({ waffleHostInterface: 1 }, "fixture")).toBe(required);
  expect(() => assertExactHostInterface(parseHostInterface(1, "family"), parseHostInterface(2, "runtime"), "family")).toThrow("does not match runtime");
});

test("wildcard placement retains one physical runtime, one lock entry, and unchanged provenance", async () => {
  await withInstallation(async root => {
    const source = join(root, "node_modules/waffle-coreutils");
    await Bun.write(join(source, "dist/cat.wasm"), new Uint8Array([0, 97, 115, 109]));
    await Bun.write(join(source, "program-derivation.json"), JSON.stringify({ sourceCommit: "a".repeat(40), sha256: "b".repeat(64) }));
    const files = [join(root, "bun.lock"), join(source, "dist/cat.wasm"), join(source, "program-derivation.json")];
    const before = await Promise.all(files.map(path => readFile(path)));
    const shell = join(root, "node_modules/bash-web");
    await mkdir(join(shell, "node_modules"));
    await symlink("../../waffle", join(shell, "node_modules/waffle"));
    expect(await assertInstalledWaffle(root, release.url)).toBe(required);
    const manifest = join(source, "package.json");
    const metadata = await Bun.file(manifest).json();
    await Bun.write(manifest, JSON.stringify({ ...metadata, peerDependencies: { waffle: release.url } }));
    expect(await assertInstalledWaffle(root, release.url)).toBe(required);
    await Bun.write(manifest, JSON.stringify(metadata));
    expect(await assertInstalledWaffle(root, release.url)).toBe(required);
    expect(await Promise.all(files.map(path => readFile(path)))).toEqual(before);
  });
});

const packages = ["waffle", "bun-wasm", "bash-web", "waffle-base", "waffle-coreutils", "@waffle/python"];
const cases = packages.flatMap(name => invalid.concat([2]).map(value => ({ name, value })));
for (const { name, value } of cases) {
  test(`${name} rejects host metadata ${JSON.stringify(value)} before any bundling`, async () => {
    await withInstallation(async root => {
      const path = join(root, "node_modules", name, "package.json");
      const metadata = await Bun.file(path).json();
      await Bun.write(path, JSON.stringify({ ...metadata, waffleHostInterface: value }));
      await expect(assertInstalledWaffle(root, historical)).rejects.toThrow("waffleHostInterface");
      await expect(bundleConsumer(root, root, join(root, "output"), async () => { throw new Error("Must not execute"); })).rejects.toThrow("waffleHostInterface");
      expect(await Bun.file(join(root, "output/index.html")).exists()).toBe(false);
    }, historical);
  });
}

test("a nested duplicate fails physical resolution even if its metadata matches", async () => {
  await withInstallation(async root => {
    const nested = join(root, "node_modules/waffle-base/node_modules/waffle/package.json");
    await Bun.write(nested, await Bun.file(join(root, "node_modules/waffle/package.json")).bytes());
    await expect(assertInstalledWaffle(root, release.url)).rejects.toThrow("One physical runtime peer");
  });
});

test("a second runtime lock entry fails even with no second installed directory", async () => {
  await withInstallation(async (root, fixture) => {
    fixture.packages["waffle-base/waffle"] = fixture.packages.waffle;
    await Bun.write(join(root, "bun.lock"), JSON.stringify(fixture.lock));
    await expect(assertInstalledWaffle(root, release.url)).rejects.toThrow("One runtime lock entry");
  });
});

test("historical exact Git peers need metadata and preserve their exact peer edge", async () => {
  await withInstallation(async root => {
    const path = join(root, "node_modules/bash-web/package.json");
    const metadata = await Bun.file(path).json();
    await Bun.write(path, JSON.stringify({ ...metadata, peerDependencies: { waffle: historical } }));
    expect(await assertInstalledWaffle(root, historical)).toBe(required);
    await Bun.write(path, JSON.stringify({ ...metadata, waffleHostInterface: undefined, peerDependencies: { waffle: historical } }));
    await expect(assertInstalledWaffle(root, historical)).rejects.toThrow("waffleHostInterface");
    await Bun.write(path, JSON.stringify({ ...metadata, peerDependencies: { waffle: historical.slice(0, -40) + "d".repeat(40) } }));
    await expect(assertInstalledWaffle(root, historical)).rejects.toThrow("exact selected runtime");
  }, historical);
  expect(waffleCommits({ SHELL_PRODUCT_SHELL_COMMIT: "a".repeat(40) }, "*").wafflePeer).toBe(release.url);
  expect(() => waffleCommits({ SHELL_PRODUCT_SHELL_COMMIT: "a".repeat(40), SHELL_PRODUCT_WAFFLE_COMMIT: "b".repeat(40) }, "*")).toThrow("must match");
});

test("published runtime dependencies remain forbidden rather than treated as wildcard peers", async () => {
  await withInstallation(async root => {
    const path = join(root, "node_modules/waffle-base/package.json");
    const metadata = await Bun.file(path).json();
    await Bun.write(path, JSON.stringify({ ...metadata, dependencies: { waffle: release.url } }));
    await expect(assertInstalledWaffle(root, release.url)).rejects.toThrow("published runtime dependency");
  });
});

test("a matching interface cannot substitute a different Git lock edge", async () => {
  await withInstallation(async (root, fixture) => {
    const before = await readFile(join(root, "bun.lock"));
    fixture.lock.workspaces[""].dependencies.waffle = historical.slice(0, -40) + "d".repeat(40);
    await Bun.write(join(root, "bun.lock"), JSON.stringify(fixture.lock));
    await expect(assertInstalledWaffle(root, historical)).rejects.toThrow("exact selected edge");
    fixture.lock.workspaces[""].dependencies.waffle = historical;
    fixture.packages.waffle = ["waffle@github:ShaulLavo/waffle#ddddddd", {}];
    await Bun.write(join(root, "bun.lock"), JSON.stringify(fixture.lock));
    await expect(assertInstalledWaffle(root, historical)).rejects.toThrow("exact selected edge");
    fixture.packages.waffle = ["waffle@github:ShaulLavo/waffle#c1cb67c", {}];
    await Bun.write(join(root, "bun.lock"), JSON.stringify(fixture.lock));
    expect(await assertInstalledWaffle(root, historical)).toBe(required);
    expect(before.toString()).toContain(historical);
  }, historical);
});

for (const value of invalid.concat([2])) {
  test(`Bun rejects host metadata ${JSON.stringify(value)} before packing or installing`, async () => {
    await withInstallation(async root => {
      const bun = join(root, "node_modules/bun-wasm");
      const metadata = await Bun.file(join(bun, "package.json")).json();
      await Bun.write(join(bun, "package.json"), JSON.stringify({ ...metadata, waffleHostInterface: value }));
      let executed = false;
      await expect(installConsumer(bun, join(root, "consumer"), async () => { executed = true; })).rejects.toThrow("waffleHostInterface");
      expect(executed).toBe(false);
    });
  });
}
