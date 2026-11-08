import { test, expect } from "bun:test";
import { mkdtemp, mkdir, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { options, run } from "./run";
import { saveReport } from "./report";

test("the actual CLI inventory discovers all missing prerequisites and reaps its real asset server", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-test-"));
  try {
    const root = join(scratch, "site"), output = join(scratch, "report");
    await mkdir(root);
    const result = await run(options([`--root=${root}`, `--output=${output}`, "--asset-source=unit-test-no-assets"]));
    expect(result.cells).toHaveLength(260);
    expect(result.cells.every(cell => cell.status === "not runnable yet" && cell.attempts.length === 0)).toBe(true);
    expect(result.resources).toHaveLength(1);
    const server = result.resources?.[0];
    expect(server?.stopped).toBe(true);
    if (!server) throw new Error("Missing asset server receipt");
    expect(() => process.kill(server.pid, 0)).toThrow();
    await expect(access(join(output, ".goals-matrix-lock"))).rejects.toThrow();
    expect(await Bun.file(join(output, "TABLE.md")).text()).toContain("260");
    const stored = await Bun.file(join(output, "TABLE.json")).json();
    expect(stored.resources[0].stopped).toBe(true);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("a rejected incomplete report never replaces the previous saved report", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-test-"));
  try {
    await Bun.write(join(scratch, "TABLE.json"), "previous result");
    await expect(saveReport(scratch, { schema: 1, run: "test", createdAt: "now", command: "test", source: { commit: "test", dirty: false, assets: {} }, cells: [] })).rejects.toThrow("260");
    expect(await Bun.file(join(scratch, "TABLE.json")).text()).toBe("previous result");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
