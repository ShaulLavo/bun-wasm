import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coverageFixture, fixtureFile, refreshFixtureSite } from "./browser-guest-coverage-fixture";
import { prepareBrowserGuestInterruptionBundle, stageBrowserGuestInterruption, verifyBrowserGuestCoverage } from "./browser-guest-coverage";
import { fullBrowserGuestSelection, withoutJscBrowserGuestSelection, type BrowserGuestSelection } from "./browser-guest-catalogue";
import { hash } from "./guest-source-manifest";

const cleanup = new Set<string>();
afterEach(() => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); cleanup.clear(); });
const browserOnly: BrowserGuestSelection = [{ owner: "worker-modules", engines: ["browser"] }];
const qjsOnly: BrowserGuestSelection = [{ owner: "installer-links", engines: ["quickjs"] }];

test("supplemental source/receipt/site qualification and immutable post-run comparison use the original site", async () => {
  const fixture = await coverageFixture(cleanup, fullBrowserGuestSelection);
  const before = readFileSync(join(fixture.out, "site.json"));
  const verified = await fixture.prepare();
  expect(verified.site).toBe(fixture.site);
  expect(verified.programs.size).toBe(6);
  expect(readFileSync(join(fixture.out, "site.json"))).toEqual(before);
  verified.assertUnchanged();
  fixtureFile(fixture.site, "added.txt", "changed after execution");
  expect(verified.assertUnchanged).toThrow("changed during execution");
});

test("unselected corrupt gzip and missing receipts are not decoded or compiled and consumers never build", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  fixtureFile(fixture.site, "bun-jsc.wasm.gz", "not gzip or Wasm");
  fixtureFile(fixture.site, "bun.wasm.gz", "not gzip or Wasm");
  rmSync(join(fixture.dist, "bun-jsc.wasm.build.json"));
  rmSync(join(fixture.dist, "bun.wasm.build.json"));
  refreshFixtureSite(fixture.out);
  const build = spyOn(Bun, "build").mockImplementation(() => { throw new Error("Unexpected consumer build"); });
  try {
    const verified = await fixture.prepare();
    expect(Array.from(verified.programs.keys())).toEqual(["bun-browser.wasm"]);
    await verifyBrowserGuestCoverage({ out: fixture.out, selection: browserOnly });
    verified.assertUnchanged();
    expect(build).not.toHaveBeenCalled();
  } finally { build.mockRestore(); }
});

test("artifact selection cannot silently omit a requested engine", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly); await fixture.prepare();
  await expect(verifyBrowserGuestCoverage({ out: fixture.out, selection: [{ owner: "worker-modules", engines: ["browser"] }, { owner: "installer-links", engines: ["jsc"] }] })).rejects.toThrow("omitted selected engine");
});
test("explicit 35-row family requires no JSC producer or side bytes", async () => {
  const fixture = await coverageFixture(cleanup, withoutJscBrowserGuestSelection);
  rmSync(join(fixture.dist, "bun-jsc.wasm.build.json"));
  rmSync(join(fixture.site, "bun-jsc.wasm.gz")); rmSync(join(fixture.site, "jsc-engine.wasm.gz"));
  refreshFixtureSite(fixture.out);
  const verified = await fixture.prepare();
  expect(verified.programs.has("bun-jsc.wasm")).toBe(false);
  expect(verified.programs.has("bun-tools.wasm")).toBe(true);
});
test("tools rows require the intentional wrong QuickJS payload as an artifact prerequisite", async () => {
  const selection: BrowserGuestSelection = [{ owner: "tools-integrity", engines: ["browser"] }];
  const fixture = await coverageFixture(cleanup, selection), verified = await fixture.prepare();
  expect(Array.from(verified.programs.keys())).toEqual(["bun-browser.wasm", "bun.wasm", "quickjs.wasm", "bun-tools.wasm"]);
  expect(verified.programs.has("bun-jsc.wasm")).toBe(false);
});

for (const name of ["bun.wasm.build.json", "bun-browser.wasm.build.json"]) {
  test(`missing selected original receipt fails: ${name}`, async () => {
    const fixture = await coverageFixture(cleanup, qjsOnly); rmSync(join(fixture.dist, name));
    await expect(fixture.prepare()).rejects.toThrow();
  });
}
test("foreign composing receipts fail while different original paired-engine source is preserved", async () => {
  const fixture = await coverageFixture(cleanup, qjsOnly);
  const path = join(fixture.dist, "bun.wasm.build.json"), receipt = JSON.parse(readFileSync(path, "utf8"));
  expect(receipt.engineOrigin.inputs.source).not.toEqual(receipt.sourceManifest.source);
  receipt.sourceManifest.source.head = "1".repeat(40);
  receipt.sourceManifestSha256 = hash(JSON.stringify(receipt.sourceManifest));
  writeFileSync(path, JSON.stringify(receipt));
  await expect(fixture.prepare()).rejects.toThrow("Foreign composing receipt");
});
for (const mutation of ["recipe", "tool", "provenance"] as const) {
  test(`selected receipt rejects an invalid ${mutation}`, async () => {
    const fixture = await coverageFixture(cleanup, qjsOnly), path = join(fixture.dist, "bun.wasm.build.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (mutation === "recipe") receipt.sourceManifest.build = "quickjs-minimal";
    if (mutation === "tool") receipt.sourceManifest.tools = receipt.sourceManifest.tools.filter((tool: { name: string }) => tool.name !== "wasm-opt");
    if (mutation === "provenance") receipt.bunHead = "f".repeat(40);
    receipt.sourceManifestSha256 = hash(JSON.stringify(receipt.sourceManifest)); writeFileSync(path, JSON.stringify(receipt));
    await expect(fixture.prepare()).rejects.toThrow();
  });
}
test("selected corrupt side, gzip and served identity fail closed", async () => {
  const fixture = await coverageFixture(cleanup, qjsOnly);
  fixtureFile(fixture.site, "quickjs.wasm.gz", Bun.gzipSync(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])));
  refreshFixtureSite(fixture.out);
  await expect(fixture.prepare()).rejects.toThrow("identity mismatch");
});
test("selected side receipt validation catches corrupt bytes even with matching delivery maps", async () => {
  const fixture = await coverageFixture(cleanup, qjsOnly);
  const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
  fixtureFile(fixture.site, "quickjs.wasm.gz", Bun.gzipSync(bytes));
  const maps = JSON.parse(readFileSync(join(fixture.site, "engine-builds.json"), "utf8")); maps["quickjs.wasm"] = hash(bytes);
  fixtureFile(fixture.site, "engine-builds.json", JSON.stringify(maps));
  fixtureFile(fixture.site, "index.html", `globalThis.__bunwasmBuilds=${JSON.stringify(maps)};`);
  refreshFixtureSite(fixture.out);
  await expect(fixture.prepare()).rejects.toThrow();
});
test("missing selected gzip fails before browser launch", async () => {
  const fixture = await coverageFixture(cleanup, qjsOnly);
  rmSync(join(fixture.site, "quickjs.wasm.gz")); refreshFixtureSite(fixture.out);
  await expect(fixture.prepare()).rejects.toThrow();
});

test("wholly absent optional shell set is an error for selected coverage", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  for (const name of ["bash-web-guests.json", "bash-web-shell.wasm", "bash-web-env.wasm"]) rmSync(join(fixture.dist, name));
  await expect(fixture.prepare()).rejects.toThrow("verified shell/env set");
});
for (const program of ["shell-engine.wasm", "env.wasm"]) {
  test(`actual served ${program} bytes must equal the verified producer bytes`, async () => {
    const fixture = await coverageFixture(cleanup, browserOnly);
    fixtureFile(fixture.site, "programs/" + program, "wrong served bytes"); refreshFixtureSite(fixture.out);
    await expect(fixture.prepare()).rejects.toThrow("Served shell/base bytes differ");
  });
}
test("compressed serving alternatives cannot substitute a foreign shell payload", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  fixtureFile(fixture.site, "programs/env.wasm.gz", Bun.gzipSync(new TextEncoder().encode("wrong"))); refreshFixtureSite(fixture.out);
  await expect(fixture.prepare()).rejects.toThrow("Served representation differs");
});

test("supplemental inventory, source and split recipe are independently enforced", async () => {
  const fixture = await coverageFixture(cleanup, qjsOnly); await fixture.prepare();
  const path = join(fixture.out, "coverage.json"), original = readFileSync(path, "utf8"), metadata = JSON.parse(original);
  metadata.source.head = "f".repeat(40); writeFileSync(path, JSON.stringify(metadata));
  await expect(verifyBrowserGuestCoverage({ out: fixture.out, selection: qjsOnly })).rejects.toThrow("Foreign supplemental");
  writeFileSync(path, original); fixtureFile(fixture.out, "coverage-receipts/extra.json", "extra");
  await expect(verifyBrowserGuestCoverage({ out: fixture.out, selection: qjsOnly })).rejects.toThrow("inventory differs");
});
test("a missing supplemental contract never falls back to local dist", async () => {
  const fixture = await coverageFixture(cleanup, browserOnly);
  await expect(verifyBrowserGuestCoverage({ out: fixture.out, selection: browserOnly })).rejects.toThrow();
});
test("interruption staging contains only selected engine closure and never alters served bytes", async () => {
  const selection: BrowserGuestSelection = [{ owner: "engine-interruption", engines: ["quickjs"] }];
  const fixture = await coverageFixture(cleanup, selection), verified = await fixture.prepare();
  const stage = join(fixture.out, "raw"); stageBrowserGuestInterruption(verified, stage);
  expect(existsSync(join(stage, "bun.wasm"))).toBe(true);
  expect(existsSync(join(stage, "quickjs.wasm"))).toBe(true);
  expect(existsSync(join(stage, "bun-browser.wasm"))).toBe(true);
  expect(existsSync(join(stage, "bun-jsc.wasm"))).toBe(false);
  verified.assertUnchanged();
  const subset = await verifyBrowserGuestCoverage({ out: fixture.out, selection });
  expect(subset.interruptionBundle).toBe(join(fixture.out, "interruption"));
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
