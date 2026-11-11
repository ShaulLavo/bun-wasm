import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight, withStagedAssets } from "./preparation";
import { options, playgroundURL } from "./run";
import { frameworks } from "./catalog";
import { profileEngineFiles } from "./engines";
import { writePreparedSiteInventory, verifyPreparedSiteInventory } from "./prepared-site";
import { pinnedBashWeb } from "../bash-web-guests";

test("goals record and carry an explicit memory profile without changing the engine", () => {
  const args = ["--asset-source=fixture", "--engines=quickjs,jsc"];
  expect(options(args).profile).toBe("split");
  expect(options(args.concat(["--profile=shared-group"])).profile).toBe("shared-group");
  expect(() => options(args.concat(["--profile=shared"]))).toThrow("Unknown Bun program memory profile");
  expect(() => options(["--asset-source=fixture", "--profile=shared-group", "--engines=spidermonkey"])).toThrow("unavailable");
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
