import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, preparationOptions, withStagedAssets } from "./preparation";
import { options, playgroundURL } from "./run";
import { frameworks } from "./catalog";
import { engineFiles, profileEngineFiles } from "./engines";
import { writePreparedSiteInventory, verifyPreparedSiteInventory } from "./prepared-site";
import { pinnedBashWeb } from "../bash-web-guests";

test("goals record and carry an explicit memory profile without changing the engine", () => {
  const args = ["--asset-source=fixture", "--engines=quickjs,jsc"];
  expect(options(args).profile).toBe("split");
  expect(options(args.concat(["--profile=shared-group"])).profile).toBe("shared-group");
  expect(() => options(args.concat(["--profile=shared"]))).toThrow("Unknown Bun program profile");
  expect(() => options(["--asset-source=fixture", "--profile=shared-group", "--engines=spidermonkey"])).toThrow("does not support");
  const url = new URL(playgroundURL("https://example.test/", frameworks[0]!, "jsc", "shared-group"));
  expect(url.searchParams.get("engine")).toBe("jsc");
  expect(url.searchParams.get("profile")).toBe("shared-group");
  expect(profileEngineFiles("jsc", "shared-group")).toEqual(["profiles/shared-group/bun-jsc.wasm", "profiles/shared-group/jsc-engine.wasm"]);
});

test("a shared preparation refuses missing assets instead of using split assets", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-profile-preflight-"));
  try {
    await Bun.write(join(scratch, "bun.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await expect(preflight(scratch, ["quickjs"], "shared-group")).rejects.toThrow("Missing quickjs shared-group assets");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("prepared inventory refuses changed shell, host, profile bytes and extra files", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-profile-inventory-"));
  try {
    const names = ["main.js", "programs/shell-engine.wasm", "profiles/shared-group/bun.wasm.gz"];
    for (const name of names) await Bun.write(join(root, name), "original");
    await writePreparedSiteInventory(root);
    await verifyPreparedSiteInventory(root);
    for (const name of names) {
      await Bun.write(join(root, name), "changed");
      await expect(verifyPreparedSiteInventory(root)).rejects.toThrow("prepared site inventory changed");
      await Bun.write(join(root, name), "original");
    }
    await Bun.write(join(root, "extra.wasm"), "extra");
    await expect(verifyPreparedSiteInventory(root)).rejects.toThrow("prepared site inventory changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the actual preparation command rejects a wrong pinned shell before building", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-profile-shell-"));
  const host = new URL("../../web/dist/index.html", import.meta.url);
  const before = await Bun.file(host).exists() ? await Bun.file(host).text() : null;
  try {
    const source = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
    await Bun.write(join(scratch, "delivery-manifest.json"), JSON.stringify({ guestSource: { head: source } }));
    await mkdir(join(scratch, "delivery/web"), { recursive: true });
    const shell = join(scratch, "shell");
    await Bun.write(join(shell, "bash-web-shell.wasm"), "shell");
    await Bun.write(join(shell, "bash-web-env.wasm"), "env");
    const expected = pinnedBashWeb(new URL("../../web", import.meta.url).pathname);
    const wrong = expected === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40);
    await Bun.write(join(shell, "bash-web-guests.json"), JSON.stringify({ bashWeb: wrong }));
    const child = Bun.spawn([process.execPath, new URL("./prepare.ts", import.meta.url).pathname, join(scratch, "delivery"), "--profile=shared-group"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BASH_WEB_GUESTS_DIR: shell } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(`consumer pins ${expected}`);
    expect(await Bun.file(host).exists() ? await Bun.file(host).text() : null).toBe(before);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("copying assets after a build with an empty embedded map fails before framework attempts", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-preflight-"));
  try {
    const data = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    await Bun.write(join(scratch, "index.html"), "<script>globalThis.__bunwasmBuilds={};</script>");
    await Bun.write(join(scratch, "engine-builds.json"), JSON.stringify({ "bun.wasm": hash, "quickjs.wasm": hash }));
    for (const name of ["bun.wasm", "quickjs.wasm"]) await Bun.write(join(scratch, name + ".gz"), Bun.gzipSync(data));
    await expect(preflight(scratch, ["quickjs"])).rejects.toThrow("Preparation error");
    await withStagedAssets(scratch, async staged => {
      expect(await Bun.file(join(staged, "quickjs.wasm")).bytes()).toEqual(data);
      const map = { "bun.wasm": hash, "quickjs.wasm": hash };
      await Bun.write(join(scratch, "index.html"), `<script>globalThis.__bunwasmBuilds=${JSON.stringify(map)};</script>`);
      await preflight(scratch, ["quickjs"]);
    });
    await Bun.write(join(scratch, "quickjs.wasm.gz"), Bun.gzipSync(new Uint8Array([1])));
    await expect(preflight(scratch, ["quickjs"])).rejects.toThrow("Preparation error");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("preparation accepts a separate SpiderMonkey pair with its source record", () => {
  const options = preparationOptions(["/delivery", "--spidermonkey=/ordinary/pair", "--spidermonkey-source=/ordinary/components.json"]);
  expect(options).toEqual({ delivery: "/delivery", spidermonkey: { directory: "/ordinary/pair", source: "/ordinary/components.json" }, shell: undefined });
  expect(preparationOptions(["/delivery"])).toEqual({ delivery: "/delivery", spidermonkey: undefined, shell: undefined });
  expect(preparationOptions(["/delivery", "--shell=/shell/guests"]).shell).toBe("/shell/guests");
  for (const flags of [["--spidermonkey=/pair"], ["--spidermonkey-source=/source.json"], ["--unknown=x"], ["--spidermonkey=/a", "--spidermonkey=/b"]]) {
    expect(() => preparationOptions(["/delivery"].concat(flags))).toThrow();
  }
});

async function checkOverlay(directory: string, original: Uint8Array<ArrayBuffer>, replacement: Uint8Array<ArrayBuffer>): Promise<void> {
  for (const name of engineFiles("spidermonkey")) expect(await Bun.file(join(directory, name)).bytes()).toEqual(replacement);
  for (const name of engineFiles("quickjs")) expect(await Bun.file(join(directory, name)).bytes()).toEqual(original);
}

test("an explicit ordinary pair replaces only SpiderMonkey and cannot fall back to delivery bytes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-overlay-"));
  const delivery = join(scratch, "delivery"), pair = join(scratch, "pair");
  const original = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const replacement = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]);
  const names = engineFiles("spidermonkey");
  let staged = "";
  try {
    for (const name of engineFiles("quickjs").concat(names)) await Bun.write(join(delivery, name + ".gz"), Bun.gzipSync(original));
    await expect(withStagedAssets(delivery, async () => { throw new Error("build must not start"); }, { spidermonkey: pair })).rejects.toThrow("Missing engine assets");
    await Bun.write(join(pair, "bun-spidermonkey.wasm"), replacement);
    await expect(withStagedAssets(delivery, async () => { throw new Error("build must not start"); }, { spidermonkey: pair })).rejects.toThrow("Missing engine assets: spidermonkey-engine.wasm");
    await Bun.write(join(pair, "spidermonkey-engine.wasm.gz"), Bun.gzipSync(replacement));
    await withStagedAssets(delivery, async directory => {
      staged = directory;
      await checkOverlay(directory, original, replacement);
    }, { spidermonkey: pair });
    expect(await Bun.file(join(staged, "bun-spidermonkey.wasm")).exists()).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

async function shellPreparation(root: string): Promise<string> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "prepare.ts"), join(root, "delivery"), `--shell=${join(root, "shell")}`,
    `--spidermonkey=${join(root, "pair")}`, `--spidermonkey-source=${join(root, "source.json")}`], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  return stderr;
}

test("explicit shell selection verifies current pin and hashes independently of the donor shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-goals-shell-"));
  const data = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const receipt = { bashWeb: "0".repeat(40), rustToolchain: "test", guests: {
    "shell-engine.wasm": { file: "bash-web-shell.wasm", bytes: data.length, sha256: hash },
    "env.wasm": { file: "bash-web-env.wasm", bytes: data.length, sha256: hash },
  } };
  try {
    await Bun.write(join(root, "delivery-manifest.json"), JSON.stringify({ guestSource: { head: "0".repeat(40) } }));
    await Bun.write(join(root, "source.json"), JSON.stringify({ purpose: "test" }));
    await Bun.write(join(root, "pair/bun-spidermonkey.wasm"), data);
    for (const guest of Object.values(receipt.guests)) await Bun.write(join(root, "shell", guest.file), data);
    await Bun.write(join(root, "shell/bash-web-guests.json"), JSON.stringify(receipt));
    expect(await shellPreparation(root)).toContain("but the consumer pins");
    receipt.bashWeb = pinnedBashWeb(join(import.meta.dir, "../../web"));
    await Bun.write(join(root, "shell/bash-web-guests.json"), JSON.stringify(receipt));
    expect(await shellPreparation(root)).toContain("Missing engine assets: spidermonkey-engine.wasm");
    await Bun.write(join(root, "shell/bash-web-shell.wasm"), new Uint8Array([1]));
    expect(await shellPreparation(root)).toContain("does not match");
  } finally { await rm(root, { recursive: true, force: true }); }
});
