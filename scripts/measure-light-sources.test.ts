import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceAttribution } from "./measure-light-sources";

test("source attribution separates UI, lazy service and required process stubs", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-light-map-"));
  const file = join(scratch, "main.js");
  try {
    await Bun.write(`${file}.map`, JSON.stringify({
      sources: ["../node_modules/@xterm/xterm/index.js", "../node_modules/waffle/proc/stub.ts", "../node_modules/waffle/proc/supervisor.ts", "../node_modules/waffle/proc/unmapped.ts"],
      mappings: "AAAA,ICAA,ICAA",
    }));
    const report = await sourceAttribution(file, "aaaaBBBBcccc");
    expect(report.runtime.bytes).toBe(8);
    expect(report.uiSources).toEqual(["../node_modules/@xterm/xterm/index.js"]);
    expect(report.processService).toEqual(["../node_modules/waffle/proc/supervisor.ts"]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("page components and models count as UI", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-light-map-"));
  const file = join(scratch, "main.js");
  try {
    await Bun.write(`${file}.map`, JSON.stringify({
      sources: ["../src/playground/playground.ts", "../src/app.tsx", "../src/sandbox.ts", "../src/runner.ts"],
      mappings: "AAAA,ICAA,ICAA,ICAA",
    }));
    const report = await sourceAttribution(file, "aaaaBBBBccccDDDD");
    expect(report.uiSources).toEqual(["../src/playground/playground.ts", "../src/app.tsx", "../src/sandbox.ts"]);
    expect(report.runtime.bytes).toBe(4);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});


test("command error bytes remain measured without labeling them process execution", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-light-map-"));
  const file = join(scratch, "main.js");
  try {
    await Bun.write(`${file}.map`, JSON.stringify({
      sources: ["../node_modules/waffle/proc/command.ts", "../node_modules/waffle/proc/command-runner.ts", "../node_modules/waffle/proc/command-stdio.ts"],
      mappings: "AAAA,ICAA,ICAA",
    }));
    const report = await sourceAttribution(file, "aaaaBBBBcccc");
    expect(report.runtime.bytes).toBe(12);
    expect(report.processService).toEqual(["../node_modules/waffle/proc/command-runner.ts", "../node_modules/waffle/proc/command-stdio.ts"]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
