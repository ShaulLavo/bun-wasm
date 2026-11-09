import { expect, test } from "bun:test";
import { frameworks } from "./catalog";
import { execute } from "./execute";
import { namedAngularDiagnostic } from "./angular-diagnostic";
import { withPlayground } from "./test-fixture";

const path = "/tmp/ng-9kxMAf/angular-errors.log";
const reference = `See "${path}" for further details.`;
type Fixture = { framework?: string; output?: string; contents?: string; fail?: boolean; owned?: boolean; missing?: boolean; symlink?: string; stalled?: boolean; slowTerminal?: boolean };

async function runFixture(config: Fixture = {}) {
  const framework = frameworks.find(item => item.id === (config.framework ?? "angular"));
  if (!framework) throw new Error("Missing framework fixture");
  return withPlayground(framework, 0, async transport => {
    const logs: string[] = [];
    const events: string[] = [];
    await transport.evaluate(`globalThis.diagnostic = ${JSON.stringify({ ...config, path, output: config.output ?? reference, bytes: Array.from(new TextEncoder().encode(config.contents ?? "RangeError: Maximum call stack size exceeded\n    at ajv/dist/compile/codegen/index.js:181:24")) })};
      globalThis.reads = [];
      playground.fs = {
        async lookup(path) { reads.push(path); return { kind: diagnostic.symlink === path ? 'symlink' : path.endsWith('.log') ? 'file' : 'dir' }; },
        async readFile(path) { reads.push(path); if (diagnostic.stalled) return new Promise(() => {}); return diagnostic.missing ? undefined : Uint8Array.from(diagnostic.bytes); }
      };
      playground.term.buffer.active = { length: 1, getLine() { return { isWrapped: false, translateToString() { return diagnostic.output; } }; } };
      const submit = playground.shell.submit.bind(playground.shell);
      playground.shell.submit = async text => { if (text === 'bun run dev' && diagnostic.fail !== false) { playground.shell.lastExit = 127; return; } return submit(text); };
      void 0`);
    const evaluate = transport.evaluate.bind(transport);
    const pending: Promise<unknown>[] = [];
    let transcripts = 0;
    transport.evaluate = async <T>(expression: string): Promise<T> => {
      if (expression.includes("async function readDiagnostic")) events.push("diagnostic");
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
    return { result, logs, events: events.slice(), durationMs, reads: await evaluate<string[]>("reads") };
  });
}

test.each([false, true])("failed Angular diagnostic survives final log save before owned cleanup = %s", async owned => {
  const observed = await runFixture({ owned });
  expect(observed.result).toMatchObject({ status: "fail", phase: "dev", error: expect.stringContaining("without listening") });
  expect(observed.result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass", timeoutMs: 20_000 });
  expect(observed.reads).toEqual(["/tmp", "/tmp/ng-9kxMAf", path, path]);
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
  expect(observed.reads.filter(value => value === path)).toHaveLength(symlink === path ? 1 : 0);
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
