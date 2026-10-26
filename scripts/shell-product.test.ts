import { expect, test } from "bun:test";
import { viteApps } from "./app-matrix/product-vite";
import { nextApps } from "./app-matrix/product-next";
import { fixtures, stages } from "../tests/shell-product/fixtures";
// These unit fixtures do not launch the product browser or stage its packages.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { guestProvenance } from "./app-matrix/product-provenance";
import { liveServer, requireLiveServer, settleResources, type Pending } from "../tests/shell-product/lifecycle";
import { PreparationFlow } from "../tests/shell-product/prepare-flow";
import { networkFiles, waffleSourcePlan } from "../tests/shell-product/waffle-stage";

test("shell product reuses unchanged original Vite React and Next 15 source and dependencies", () => {
  expect(fixtures.map(fixture => fixture.id)).toEqual(["vite-react", "next-15-app"]);
  for (const fixture of fixtures) {
    const source = viteApps.concat(nextApps).find(app => app.id === fixture.id);
    expect(source).toBeDefined();
    if (!source) throw new Error(`Missing catalog fixture ${fixture.id}`);
    expect(fixture.files).toBe(source.files);
    expect(fixture.dependencies).toBe(source.dependencies);
    expect(fixture.buildOutputs.length).toBeGreaterThan(0);
  }
});

test("both real development commands accept the default and inline PORT override", () => {
  for (const fixture of fixtures) {
    expect(fixture.scripts.dev).toContain("--port ${PORT:-3137}");
    expect(fixture.dependencies[fixture.tool]).toBeDefined();
    expect(fixture.scripts.build).toBe(`${fixture.tool} build`);
  }
});

test("scoreboard includes every required stage and all three stop cycles", () => {
  expect(new Set(stages).size).toBe(stages.length);
  expect(stages.filter(name => /^ctrl-c-\d$/.test(name))).toEqual(["ctrl-c-1", "ctrl-c-2", "ctrl-c-3"]);
  expect(stages).toContain("install-and-dev-dom");
  expect(stages).toContain("build-tail");
  expect(stages).toContain("bun-x-grep");
  expect(stages).toContain("redirect");
  expect(stages).toContain("and-or-status");
  expect(stages).toContain("cwd");
  expect(stages).toContain("port-3001-dom");
});

test("Ctrl-C rejects an exited server, a prompt, a command, and a missing or wrong listener", () => {
  const server: Pending = { kind: "server", port: 3137, offset: 0, entered: true };
  const ports = new Map([[3137, {}]]);
  expect(liveServer(server, 2, ports)).toBe(true);
  expect(() => requireLiveServer(server, 2, ports)).not.toThrow();
  for (const phase of [0, 1, 2]) expect(liveServer(server, phase, ports)).toBe(phase !== 1);
  expect(() => requireLiveServer(server, 1, ports)).toThrow("live foreground");
  expect(() => requireLiveServer(server, 2, new Map())).toThrow("expected listener");
  expect(() => requireLiveServer(server, 2, new Map([[3001, {}]]))).toThrow("expected listener");
  expect(() => requireLiveServer({ ...server, entered: false }, 2, ports)).toThrow();
  expect(() => requireLiveServer({ kind: "command", offset: 0, token: "done" }, 2, ports)).toThrow();
  expect(() => requireLiveServer(undefined, 2, ports)).toThrow();
});

test("preparation cancellation during filesystem work waits for main before deleting and forbids late spawning", async () => {
  const directory = await mkdtemp("/work/tmp/bw-sp-flow-");
  const flow = new PreparationFlow();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const running = flow.run(async () => {
    entered.resolve();
    await release.promise;
    await Bun.write(join(directory, "late-write"), "an already pending filesystem continuation");
    events.push("main continued");
    await flow.execute([process.execPath, "-e", 'throw new Error("must not spawn")'], directory);
  }, async () => { events.push("cleanup"); await rm(directory, { recursive: true, force: true }); });
  const outcome = running.then(() => undefined, (error: unknown) => error);
  try {
    await entered.promise;
    flow.cancel(new Error("cancel during I/O"));
    expect(existsSync(directory)).toBe(true);
    release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(events).toEqual(["main continued", "cleanup"]);
    expect(existsSync(directory)).toBe(false);
    expect(() => flow.execute([process.execPath, "-e", "0"], directory)).toThrow("cancel during I/O");
  } finally { release.resolve(); await running.catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

test("preparation cancellation stops an actual owned detached child before cleanup", async () => {
  const directory = await mkdtemp("/work/tmp/bw-sp-child-");
  const flow = new PreparationFlow();
  const ready = join(directory, "pid");
  const running = flow.run(() => flow.execute([process.execPath, "-e", `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`], directory), () => rm(directory, { recursive: true, force: true }));
  const outcome = running.then(() => undefined, (error: unknown) => error);
  try {
    for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const pid = Number(await Bun.file(ready).text());
    flow.cancel(new Error("stop owned child"));
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(directory)).toBe(false);
  } finally { flow.cancel(new Error("stop owned child")); await running.catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

test("all teardown continues after capture and independent close failures", async () => {
  const directory = await mkdtemp("/work/tmp/bw-sp-close-");
  const events: string[] = [];
  const hostCleanup = () => settleResources([
    () => { events.push("server"); throw new Error("server close failed"); },
    () => { events.push("mirror"); },
    async () => { events.push("scratch"); await rm(directory, { recursive: true, force: true }); },
  ]);
  try {
    await expect(settleResources([
      () => Bun.write(directory, "capture fails because this is a directory"),
      () => { events.push("browser"); throw new Error("browser close failed"); },
      hostCleanup,
    ])).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(["browser", "server", "mirror", "scratch"]);
    expect(existsSync(directory)).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Waffle staging names selected Git source and verifies borrowed network before fresh JS with rebuild forbidden", () => {
  const commit = "c1cb67c300439af24335d0b2ec481bfb52f79a01";
  const env = { WAFFLE_NETWORK_PREBUILT: "0", CARGO_TARGET_DIR: "/owned/cargo" };
  const plan = waffleSourcePlan("/read-only/repository", commit, "/owned/source.tar", "/owned/waffle", env);
  expect(plan.map(step => step.command)).toEqual([
    ["git", "-C", "/read-only/repository", "archive", "--format=tar", "--output", "/owned/source.tar", commit],
    ["tar", "-xf", "/owned/source.tar", "-C", "/owned/waffle"],
    [process.execPath, "tooling/build-network.ts", "--verify"],
    [process.execPath, "prepare.ts"],
  ]);
  expect(plan.slice(2).map(step => step.cwd)).toEqual(["/owned/waffle", "/owned/waffle"]);
  for (const step of plan) expect(step.env.WAFFLE_NETWORK_PREBUILT).toBe("1");
  expect(env.WAFFLE_NETWORK_PREBUILT).toBe("0");
  expect(networkFiles).toEqual(["network.wasm", "network.sha256", "network.input-hash"]);
  expect(() => waffleSourcePlan("/repo", "not-a-commit", "/archive", "/destination", {})).toThrow();
});

test("strict independent guest provenance rejects duplicate, commented digest, wrong bytes and invalid source", () => {
  const sha256 = "a".repeat(64);
  const receipt = `source_commit=${"b".repeat(40)}\nsource_tree=${"c".repeat(40)}\nguest_sha256=${sha256}\nguest_bytes=8\ndate=fixture\nfeatures=browser\ntarget=wasm32-wasip1\n`;
  expect(guestProvenance(receipt, { sha256, bytes: 8 }).source_commit).toBe("b".repeat(40));
  expect(() => guestProvenance(`${receipt}guest_sha256=${sha256}\n`, { sha256, bytes: 8 })).toThrow("Duplicate");
  expect(() => guestProvenance(receipt.replace(sha256, "d".repeat(64)) + `#guest_sha256=${sha256}\n`, { sha256, bytes: 8 })).toThrow("does not match");
  expect(() => guestProvenance(receipt, { sha256, bytes: 9 })).toThrow("does not match");
  expect(() => guestProvenance(receipt.replace("b".repeat(40), "invalid"), { sha256, bytes: 8 })).toThrow("Invalid guest source");
});
