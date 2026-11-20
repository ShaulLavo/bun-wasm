import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { coverageFixture, fixtureFile } from "./browser-guest-coverage-fixture";
import { prepareBrowserGuestInterruptionBundle, stageBrowserGuestInterruption, verifyBrowserGuestCoverage } from "./browser-guest-coverage";
import { fullBrowserGuestSelection, withoutJscBrowserGuestSelection, type BrowserGuestSelection } from "./browser-guest-catalogue";
import { hash } from "./guest-source-manifest";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";

const cleanup = new Set<string>();
afterEach(() => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); cleanup.clear(); });
const browserOnly: BrowserGuestSelection = [{ owner: "worker-modules", engines: ["browser"] }];
const qjsOnly: BrowserGuestSelection = [{ owner: "installer-links", engines: ["quickjs"] }];

function replaceProgram(site: string, name: string, bytes: Uint8Array<ArrayBuffer>): void {
  const maps = JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8"));
  maps[name] = hash(bytes);
  fixtureFile(site, name + ".gz", Bun.gzipSync(bytes));
  fixtureFile(site, "engine-builds.json", JSON.stringify(maps));
  fixtureFile(site, "index.html", `globalThis.__bunwasmBuilds=${JSON.stringify(maps)};`);
  if (name !== "bun-browser.wasm") return;
  fixtureFile(site, "sandbox/bun-browser.wasm.gz", Bun.gzipSync(bytes));
  fixtureFile(site, "sandbox/engine-builds.json", JSON.stringify({ [name]: hash(bytes) }));
}

test.each([
  { name: "bun.wasm", selection: qjsOnly, bytes: quickjsPair("jsc").core, error: "Wrong coverage core kind" },
  { name: "quickjs.wasm", selection: qjsOnly, bytes: quickjsPair("jsc").side, error: "companion" },
  { name: "bun-browser.wasm", selection: browserOnly, bytes: quickjsPair().core, error: "Wrong coverage core kind" },
  { name: "bun-tools.wasm", selection: [{ owner: "tools-integrity", engines: ["browser"] }] satisfies BrowserGuestSelection,
    bytes: quickjsPair().core, error: "Wrong coverage core kind" },
])("selected $name rejects a valid but mislabeled engine program", async ({ name, selection, bytes, error }) => {
  const fixture = await coverageFixture(cleanup, selection);
  replaceProgram(fixture.site, name, bytes);
  await expect(fixture.prepare()).rejects.toThrow(error);
});

test("selected programs work directly without development receipts or a source inventory", async () => {
  const fixture = await coverageFixture(cleanup, fullBrowserGuestSelection);
  const verified = await fixture.prepare();
  expect(verified.site).toBe(fixture.site);
  expect(verified.programs.size).toBe(6);
  for (const name of ["coverage.json", "coverage-receipts", "site.json"]) expect(existsSync(join(fixture.out, name))).toBe(false);
});
test("owned coverage fixtures honor the configured temporary root", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "bun-wasm-portable-fixture-")); cleanup.add(temporary);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  try {
    const fixture = await coverageFixture(cleanup, browserOnly);
    expect(fixture.out.startsWith(temporary + "/")).toBe(true);
    await fixture.prepare();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});
test("unselected corrupt gzip is not decoded or compiled and consumers never build", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  fixtureFile(fixture.site, "bun-jsc.wasm.gz", "not gzip or Wasm");
  fixtureFile(fixture.site, "bun.wasm.gz", "not gzip or Wasm");
  const build = spyOn(Bun, "build").mockImplementation(() => { throw new Error("Unexpected consumer build"); });
  try {
    const verified = await fixture.prepare();
    expect(Array.from(verified.programs.keys())).toEqual(["bun-browser.wasm"]);
    expect(build).not.toHaveBeenCalled();
  } finally { build.mockRestore(); }
});
test("requested engine missing from a larger producer fails before execution", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  rmSync(join(fixture.site, "jsc-engine.wasm.gz"));
  await fixture.prepare();
  await expect(verifyBrowserGuestCoverage({ out: fixture.out, selection: [{ owner: "installer-links", engines: ["jsc"] }] })).rejects.toThrow("jsc-engine.wasm.gz");
});
test("explicit 35-row family requires no JSC producer or side bytes", async () => {
  const fixture = await coverageFixture(cleanup, withoutJscBrowserGuestSelection);
  rmSync(join(fixture.site, "bun-jsc.wasm.gz")); rmSync(join(fixture.site, "jsc-engine.wasm.gz"));
  const verified = await fixture.prepare();
  expect(verified.programs.has("bun-jsc.wasm")).toBe(false);
  expect(verified.programs.has("bun-tools.wasm")).toBe(true);
});
test("tools rows require the intentional wrong QuickJS payload", async () => {
  const fixture = await coverageFixture(cleanup, [{ owner: "tools-integrity", engines: ["browser"] }]);
  expect(Array.from((await fixture.prepare()).programs.keys())).toEqual(["bun-browser.wasm", "bun.wasm", "quickjs.wasm", "bun-tools.wasm"]);
});
for (const name of ["bun.wasm.gz", "quickjs.wasm.gz", "bun-browser.wasm.gz", "worker.js", "programs/shell-engine.wasm", "programs/env.wasm"]) {
  test(`missing runtime input fails before browser launch: ${name}`, async () => {
    const fixture = await coverageFixture(cleanup, qjsOnly);
    rmSync(join(fixture.site, name));
    await expect(fixture.prepare()).rejects.toThrow(name);
  });
}
test("selected corrupt side and served identity fail closed", async () => {
  const fixture = await coverageFixture(cleanup, qjsOnly);
  fixtureFile(fixture.site, "quickjs.wasm.gz", Bun.gzipSync(new Uint8Array(8)));
  await expect(fixture.prepare()).rejects.toThrow("identity mismatch");
  const maps = JSON.parse(readFileSync(join(fixture.site, "engine-builds.json"), "utf8"));
  maps["quickjs.wasm"] = hash(new Uint8Array(8));
  fixtureFile(fixture.site, "engine-builds.json", JSON.stringify(maps));
  fixtureFile(fixture.site, "index.html", `globalThis.__bunwasmBuilds=${JSON.stringify(maps)};`);
  await expect(fixture.prepare()).rejects.toThrow("Invalid split coverage program");
});
test("a foreign raw serving alternative cannot replace the selected gzip", async () => {
  const fixture = await coverageFixture(cleanup, qjsOnly);
  fixtureFile(fixture.site, "bun.wasm", "foreign raw alternative");
  await expect(fixture.prepare()).rejects.toThrow("Served representation differs");
});
test("missing base assets fail independently of any supplied inventory", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  rmSync(join(fixture.site, "programs/base"), { recursive: true });
  await expect(fixture.prepare()).rejects.toThrow("programs/base/");
});
test("the sandbox must contain the same actual Browser guest", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  fixtureFile(fixture.site, "sandbox/bun-browser.wasm.gz", Bun.gzipSync(new Uint8Array(8)));
  await expect(fixture.prepare()).rejects.toThrow("Sandbox guest differs");
});
for (const name of ["worker.js", "preview1-worker.js", "engine-interruption-worker.js"]) {
  test(`selected interruption requires its actual bundle entry: ${name}`, async () => {
    const fixture = await coverageFixture(cleanup, [{ owner: "engine-interruption", engines: ["quickjs"] }]);
    rmSync(join(fixture.out, "interruption", name));
    await expect(fixture.prepare()).rejects.toThrow(`Missing interruption bundle entry: ${name}`);
  });
}
test("interruption staging contains only selected engine closure", async () => {
  const selection: BrowserGuestSelection = [{ owner: "engine-interruption", engines: ["quickjs"] }];
  const fixture = await coverageFixture(cleanup, selection), verified = await fixture.prepare();
  const stage = join(fixture.out, "raw"); stageBrowserGuestInterruption(verified, stage);
  for (const name of ["bun.wasm", "quickjs.wasm", "bun-browser.wasm"]) expect(existsSync(join(stage, name))).toBe(true);
  expect(existsSync(join(stage, "bun-jsc.wasm"))).toBe(false);
  expect((await verifyBrowserGuestCoverage({ out: fixture.out, selection })).interruptionBundle).toBe(join(fixture.out, "interruption"));
});
test("bundled SpiderMonkey receipts are optional and verify the site's served pair, failing closed", async () => {
  const selection: BrowserGuestSelection = [{ owner: "engine-interruption", engines: ["quickjs"] }];
  const fixture = await coverageFixture(cleanup, selection);
  expect((await fixture.prepare()).interruptionSpiderMonkey).toBe(false);
  fixtureFile(fixture.out, "interruption/spidermonkey/inputs.json", "{}");
  await expect(fixture.prepare()).rejects.toThrow("bun-spidermonkey.wasm.gz");
  replaceProgram(fixture.site, "bun-spidermonkey.wasm", quickjsPair().core);
  replaceProgram(fixture.site, "spidermonkey-engine.wasm", quickjsPair().side);
  await expect(fixture.prepare()).rejects.toThrow("Invalid SpiderMonkey side/core inputs");
  fixtureFile(fixture.site, "spidermonkey-engine.wasm.gz", Bun.gzipSync(new Uint8Array(8)));
  await expect(fixture.prepare()).rejects.toThrow("Served program identity mismatch: spidermonkey-engine.wasm");
});
test("unselected interruption performs no build; selected output is exclusively created once", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  const build = spyOn(Bun, "build").mockImplementation(() => { throw new Error("Synthetic build boundary"); });
  try {
    expect(await prepareBrowserGuestInterruptionBundle({ out: fixture.out, selection: browserOnly })).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
    const selection: BrowserGuestSelection = [{ owner: "engine-interruption", engines: ["quickjs"] }];
    await expect(prepareBrowserGuestInterruptionBundle({ out: fixture.out, selection })).rejects.toThrow("Synthetic build boundary");
    const count = build.mock.calls.length;
    await expect(prepareBrowserGuestInterruptionBundle({ out: fixture.out, selection })).rejects.toThrow();
    expect(build.mock.calls.length).toBe(count);
  } finally { build.mockRestore(); }
});
