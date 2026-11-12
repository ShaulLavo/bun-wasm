import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOwnershipSmoke } from "./fixtures/safari-ownership-smoke";
import { ownershipReceipt, type SafariOwnershipEvent } from "./safari-ownership";

const event: SafariOwnershipEvent = { sequence: 1, event: 1, at: "2026-11-12T00:00:00.000Z", sessionId: "own-session", hostHandle: "own-host", admission: "active", operation: { kind: "frame-present", token: "own-token" }, outcome: { state: "dispatched" } };

test("synchronous append retains source and attempt identity without overwriting earlier or resumed captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-ownership-"));
  try {
    await mkdir(join(root, "logs"));
    const identity = { run: "run", source: { commit: "source", dirty: false }, cell: "vite-react/safari/spidermonkey", attempt: 1 };
    const sink = ownershipReceipt(root, identity);
    sink(event);
    const first = (await readdir(join(root, "logs")))[0]!;
    const before = await readFile(join(root, "logs", first), "utf8");
    expect(JSON.parse(before)).toMatchObject({ schema: 1, ...identity, ...event });
    sink({ ...event, sequence: 2 });
    ownershipReceipt(root, identity)(event);
    ownershipReceipt(root, { ...identity, attempt: 2 })(event);
    const files = await readdir(join(root, "logs"));
    expect(files).toHaveLength(3);
    const retained = await readFile(join(root, "logs", first), "utf8");
    expect(retained.startsWith(before)).toBe(true);
    expect(retained.trim().split("\n")).toHaveLength(2);
    expect((await stat(join(root, "logs", first))).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real standalone native fixture bundle imports without Playwright or a dependency install", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-ownership-bundle-"));
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
  try {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/safari-ownership-smoke.ts")], target: "bun", format: "esm", outdir: root, naming: "fixture.mjs" });
    expect(result.success, result.logs.map(String).join("\n")).toBe(true);
    const path = join(root, "fixture.mjs");
    const built = await readFile(path, "utf8");
    expect(built).not.toMatch(/from ["']playwright|node_modules\/playwright/);
    child = Bun.spawn([process.execPath, "--eval", `const fixture = await import(${JSON.stringify(path)}); console.log(typeof fixture.runOwnershipSmoke);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    expect(output).toBe(typeof runOwnershipSmoke + "\n");
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
