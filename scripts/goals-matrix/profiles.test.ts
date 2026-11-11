import { expect, test } from "bun:test";
import { initialReport, options, playgroundURL } from "./run";
import { nativeRunnerArgs } from "./fleet";
import { frameworks } from "./catalog";
import { ready } from "./playground";
import { withPlayground } from "./test-fixture";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const framework = frameworks.find(item => item.id === "vite-react");
if (!framework) throw new Error("Vite React template is missing");
const args = ["--asset-source=profile-test", "--engines=quickjs,jsc", "--browsers=safari", "--mac-lane=profile-test", "--mac-thread=profile-test"];

test("goals profile selection reaches both playground URLs and the remote FIFO runner", () => {
  expect(options(args).profile).toBe("split");
  const config = options(args.concat("--profile=shared-group"));
  expect(config.profile).toBe("shared-group");
  expect(options(nativeRunnerArgs(config, "/Users/test/goals")).profile).toBe("shared-group");
  const url = new URL(playgroundURL("http://test/", framework, "jsc", config.profile));
  expect(url.searchParams.get("profile")).toBe("shared-group");
  expect(new URL(playgroundURL("http://test/", framework, "browser")).searchParams.get("profile")).toBe("split");
  expect(() => options(args.concat("--profile=unknown"))).toThrow("Unknown Bun program profile");
  for (const engine of ["browser", "spidermonkey"]) {
    expect(() => options([`--engines=${engine}`, "--asset-source=test", "--profile=shared-group"])).toThrow("does not support");
  }
});

test("readiness reads the running profile instead of trusting a requested URL or engine label", () => withPlayground(framework, 0, async transport => {
  expect(await ready(transport, "browser", 100)).toHaveProperty("profile", "split");
  await expect(ready(transport, "browser", 100, "shared-group")).rejects.toThrow("expected shared-group, observed split");
  await transport.evaluate('location.href = "http://fixture/?engine=quickjs&profile=shared-group"; document.querySelector = selector => selector === "#engine" ? { value: "quickjs" } : { textContent: "QuickJS ready" };');
  await transport.evaluate('playground.profile = "shared-group"');
  expect(await ready(transport, "quickjs", 100, "shared-group")).toHaveProperty("profile", "shared-group");
  await expect(ready(transport, "quickjs", 100, "split")).rejects.toThrow("expected split, observed shared-group");
}));

test("staged reports cannot silently change their selected program profile", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-profile-"));
  try {
    const root = join(scratch, "site"), sourceFile = join(scratch, "source.json");
    await mkdir(root);
    const config = options(args.concat(`--root=${root}`));
    const first = await initialReport(config);
    await Bun.write(sourceFile, JSON.stringify({ ...first.source, dirty: false }));
    expect((await initialReport({ ...config, sourceFile })).source.assets).toHaveProperty("profile", "split");
    await expect(initialReport({ ...config, sourceFile, profile: "shared-group" })).rejects.toThrow("Staged assets differ");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
