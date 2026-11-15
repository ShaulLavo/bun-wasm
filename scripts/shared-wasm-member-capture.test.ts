import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

test("the selected shared engine retains blocked child stderr, identity and host boundaries without draining its pipe", () => {
  const output = execFileSync(process.execPath, ["web/tests/shared-wasm-memory-browser.ts", "chromium"], {
    cwd: join(import.meta.dir, ".."), encoding: "utf8", env: { ...process.env, BUN_WASM_SPIDERMONKEY_TIER: "interp", SHARED_WASM_ENTRY: "member-capture-control.ts", SHARED_WASM_CONTROL: "member-capture" },
  });
  const records = output.trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const blocked = records.find(record => record.blockedMemberCapture)?.blockedMemberCapture;
  expect(blocked).toBeDefined();
  const waiting = blocked.members.find((member: { argv: string[] }) => member.argv.includes("wait"));
  expect(waiting.pid).toBeGreaterThan(0);
  expect(waiting.agent).toMatch(/^shared-wasm-agent-/);
  expect(waiting.observation).toEqual({ kind: "pending" });
  expect(waiting.capture.value.stderr).toBe("member capture buffered stderr\n");
  expect(waiting.capture.value.active.at(-1).boundary).toBe("runtime_nested.Call");
  expect(waiting.capture.value.active.at(-1).stack).toContain("Entered runtime_nested.Call");
  const ended = records.find(record => record.entry === "member-capture-control.ts");
  expect(ended.code).toBe(0);
  expect(ended.stdout).toBe("shared-wasm member capture: pass\n");
  expect(ended.pageErrors).toEqual([]);
  expect(ended.groups).toEqual([]);
  expect(ended.budget).toBe(0);
  const normal = ended.members.find((member: { argv: string[] }) => member.argv.includes("exit"));
  expect(normal.capture.value.stderr).toBe("member capture host stderr control\nmember capture buffered stderr\n");
  expect(normal.messages).toContainEqual(expect.objectContaining({ type: "exit", code: 7 }));
  expect(normal.capture.value.phase).toMatch(/cleanup-entered|bootstrap-returned/);
  expect(normal.messages[0].cleanupErrors).toEqual([expect.stringContaining("Error: member capture cleanup failure control")]);
  expect(normal.capture.value.failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ boundary: "control.caught-range-error", stack: expect.stringContaining("RangeError: member capture caught RangeError control") }),
    expect.objectContaining({ boundary: "control.wasm-trap", stack: expect.stringContaining("RuntimeError: unreachable") }),
    expect.objectContaining({ stack: expect.stringContaining("RangeError: member capture worker event control") }),
    expect.objectContaining({ boundary: "beforeFinish", stack: expect.stringContaining("member capture cleanup failure control") }),
  ]));
  expect(normal.stop).toBe("native-terminate-returned");
  expect(normal.observation).toEqual({ kind: "terminated" });
  for (const member of ended.members) expect(member.capture.value.observationErrors).toBe(0);
}, 600_000);

test("a real page failure retains its earlier blocked-member checkpoint and the original error", () => {
  const child = spawnSync(process.execPath, ["web/tests/shared-wasm-memory-browser.ts", "chromium"], {
    cwd: join(import.meta.dir, ".."), encoding: "utf8", env: { ...process.env, BUN_WASM_SPIDERMONKEY_TIER: "interp", SHARED_WASM_ENTRY: "member-capture-control.ts", SHARED_WASM_CONTROL: "member-capture-failure" },
  });
  expect(child.status).toBe(1);
  const records = child.stderr.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const failure = records.find(record => record.sharedWasmFailure);
  expect(failure.sharedWasmFailure.stack).toMatch(/page|context|browser.*closed/i);
  const member = failure.checkpoint.members.find((member: { argv: string[] }) => member.argv.includes("wait"));
  expect(member.capture.value.stderr).toBe("member capture buffered stderr\n");
  expect(member.capture.value.active.at(-1).boundary).toBe("runtime_nested.Call");
  expect(records.find(record => record.captureReadFailure).checkpoint).toEqual(failure.checkpoint);
}, 600_000);
