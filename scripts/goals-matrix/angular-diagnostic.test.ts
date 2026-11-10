import { expect, test } from "bun:test";
import { frameworks } from "./catalog";
import { execute } from "./execute";
import { namedAngularDiagnostic, buildAngularDiagnosticSource } from "./angular-diagnostic";
import { diagnosticFilesystem, diagnosticPath, type DiagnosticFixture } from "./angular-diagnostic-fixture";
import { withPlayground } from "./test-fixture";

const path = diagnosticPath;
const reference = `See "${path}" for further details.`;
type Fixture = DiagnosticFixture & { framework?: string; output?: string; fail?: boolean; owned?: boolean; slowTerminal?: boolean };

async function runFixture(config: Fixture = {}) {
  const framework = frameworks.find(item => item.id === (config.framework ?? "angular"));
  if (!framework) throw new Error("Missing framework fixture");
  const filesystem = diagnosticFilesystem(config);
  try { return await withPlayground(framework, 0, async transport => {
    const logs: string[] = [];
    const events: string[] = [];
    await transport.evaluate(`globalThis.diagnostic = ${JSON.stringify({ ...config, output: config.output ?? reference })};
      playground.term.buffer.active = { length: 1, getLine() { return { isWrapped: false, translateToString() { return diagnostic.output; } }; } };
      const submit = playground.shell.submit.bind(playground.shell);
      playground.shell.submit = async text => { if (text === 'bun run dev' && diagnostic.fail !== false) { playground.shell.lastExit = 127; return; } return submit(text); };
      void 0`);
    const evaluate = transport.evaluate.bind(transport);
    const pending: Promise<unknown>[] = [];
    let transcripts = 0;
    transport.evaluate = async <T>(expression: string): Promise<T> => {
      if (expression.includes("const read = globalThis.__goalsReadAngularDiagnostic")) events.push("diagnostic");
      if (expression.includes("function transcript")) transcripts++;
      const delay = config.slowTerminal && transcripts === 3 && expression.includes("function transcript");
      const operation = (async () => { if (delay) await Bun.sleep(2050); return evaluate<T>(expression); })();
      if (delay) pending.push(operation);
      return operation;
    };
    if (config.owned) transport.cleanup = async () => { events.push("cleanup"); return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
    const close = transport.close.bind(transport);
    transport.close = async () => { events.push("close"); await close(); };
    const started = performance.now();
    const result = await execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "browser" }, url: "http://fixture/?engine=browser", timeoutMs: 500,
      async createTransport() { return transport; }, async saveLog(text) { events.push("save"); logs.push(text); },
    });
    const durationMs = performance.now() - started;
    await Promise.all(pending);
    expect(filesystem.disposed()).toBe(true);
    expect(await evaluate("typeof globalThis.__goalsReadAngularDiagnostic")).toBe("undefined");
    return { result, logs, events: events.slice(), durationMs, reads: filesystem.operations, readInodes: filesystem.readInodes, ranges: filesystem.ranges, expected: filesystem.expected, replaced: filesystem.replaced() };
  }, 0, filesystem.filesystem); }
  finally { await filesystem.close(); }
}

test.each([false, true])("failed Angular diagnostic survives final log save before owned cleanup = %s", async owned => {
  const observed = await runFixture({ owned });
  expect(observed.result).toMatchObject({ status: "fail", phase: "dev", error: expect.stringContaining("without listening") });
  expect(observed.result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass", timeoutMs: 20_000 });
  expect(observed.reads).toEqual(["preopen", "resolve", "stat", "resolve", "stat", "resolve", "stat", "stat", "read"]);
  expect(observed.readInodes).toEqual([observed.expected]);
  expect(observed.ranges).toEqual([[16_384, 0]]);
  expect(observed.logs).toHaveLength(2);
  for (const log of observed.logs) expect(log).toContain("at ajv/dist/compile/codegen/index.js:181:24");
  expect(observed.events[0]).toBe("diagnostic");
  expect(observed.events.at(-1)).toBe(owned ? "cleanup" : "close");
});

test.each([
  { fail: false },
  { framework: "astro" },
  { output: "Unrelated failure" },
  { output: 'See "/home/user/private.log" for further details.' },
  { output: 'See "/tmp/ng-abc/../angular-errors.log" for further details.' },
])("only a failed Angular phase with an exact named diagnostic reads guest files: %j", async config => {
  const observed = await runFixture(config);
  expect(observed.reads).toEqual([]);
  expect(observed.logs.at(-1)).not.toContain("--- Guest Angular diagnostic:");
  expect(observed.result.status).toBe(config.fail === false ? "pass" : "fail");
});

test.each(["/tmp", "/tmp/ng-9kxMAf", path])("refuses symlink at %s without reading its target", async symlink => {
  const observed = await runFixture({ symlink });
  expect(observed.readInodes).toEqual([]);
  expect(observed.logs.at(-1)).toContain("Guest Angular diagnostic unavailable");
  expect(observed.result).toMatchObject({ status: "fail", phase: "dev" });
});

test("a missing diagnostic preserves failure and cleanup", async () => {
  const observed = await runFixture({ missing: true });
  expect(observed.logs.at(-1)).toContain("Guest Angular diagnostic unavailable");
  expect(observed.result).toMatchObject({ status: "fail", phase: "dev" });
  expect(observed.events.at(-1)).toBe("close");
});

test("retains only a bounded tail", async () => {
  const contents = "discarded prefix\n" + "x".repeat(20_000) + "\n" + Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n");
  const observed = await runFixture({ contents });
  expect(observed.logs.at(-1)).toContain("truncated to last 16 KiB / 100 lines");
  expect(observed.logs.at(-1)).toContain("line 119");
  expect(observed.logs.at(-1)).not.toContain("discarded prefix");
  expect(observed.logs.at(-1)).not.toContain("line 19\n");
});

test("a stalled read consumes the existing two-second observation allowance and still tears down", async () => {
  const observed = await runFixture({ stalled: true, owned: true });
  expect(observed.durationMs).toBeGreaterThanOrEqual(1900);
  expect(observed.durationMs).toBeLessThan(3000);
  expect(observed.logs.at(-1)).toContain("Guest Angular diagnostic unavailable");
  expect(observed.events.at(-1)).toBe("cleanup");
});

test("a late terminal response cannot start guest capture after the observation deadline", async () => {
  const observed = await runFixture({ slowTerminal: true, owned: true });
  expect(observed.reads).toEqual([]);
  expect(observed.events.at(-1)).toBe("cleanup");
}, 10_000);

test("rejects misleading references and accepts the observed Angular path", () => {
  expect(namedAngularDiagnostic(reference)).toBe(path);
  expect(namedAngularDiagnostic(`prefix ${reference}`)).toBeUndefined();
  expect(namedAngularDiagnostic('See "/tmp/ng-abc/secret.txt" for further details.')).toBeUndefined();
});

test.each(["/tmp", "/tmp/ng-9kxMAf", path])("replacement of %s after resolution cannot redirect the retained handle", async replaced => {
  const observed = await runFixture({ replacement: { path: replaced, after: "resolve" } });
  expect(observed.replaced).toBe(true);
  expect(observed.readInodes.every(inode => inode === observed.expected)).toBe(true);
  expect(observed.logs.at(-1)).not.toContain("PRIVATE FILE MUST NOT BE READ");
  expect(observed.result).toMatchObject({ status: "fail", phase: "dev" });
});

test.each(["/tmp", "/tmp/ng-9kxMAf", path])("replacement of checked %s before reading cannot expose a private target", async replaced => {
  const observed = await runFixture({ replacement: { path: replaced, after: "stat" } });
  expect(observed.replaced).toBe(true);
  if (replaced === path) {
    expect(observed.readInodes).toEqual([observed.expected]);
    expect(observed.logs.at(-1)).toContain("at ajv/dist/compile/codegen/index.js:181:24");
  } else {
    expect(observed.readInodes).toEqual([]);
    expect(observed.logs.at(-1)).toContain("Guest Angular diagnostic unavailable");
  }
  expect(observed.logs.at(-1)).not.toContain("PRIVATE FILE MUST NOT BE READ");
});

test("portable fleet bundle embeds the same pinned reader without remote source dependencies", async () => {
  const diagnostic = await buildAngularDiagnosticSource();
  const built = await Bun.build({ entrypoints: [new URL("./angular-diagnostic.ts", import.meta.url).pathname], target: "bun", define: { __GOALS_ANGULAR_DIAGNOSTIC__: JSON.stringify(diagnostic) } });
  expect(built.success).toBe(true);
  const source = await built.outputs[0]?.text();
  if (!source) throw new Error("Missing portable reader bundle");
  const embedded: unknown = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  if (!embedded || typeof embedded !== "object" || !("angularDiagnostic" in embedded) || typeof embedded.angularDiagnostic !== "function") throw new Error("Missing embedded reader export");
  await expect(embedded.angularDiagnostic({ async evaluate(expression: string) { expect(expression).toContain("const read = globalThis.__goalsReadAngularDiagnostic"); throw new Error("Embedded reader evaluated"); } }, path, Date.now() + 2000)).rejects.toThrow("Embedded reader evaluated");
});
