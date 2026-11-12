import { expect, test } from "bun:test";
import { frameworks } from "./catalog";
import { execute } from "./execute";
import { options } from "./run";
import { nativeRunnerArgs } from "./fleet";
import { command } from "./playground";
import { Scope } from "./scope";
import { scoped, type Transport } from "./transport";
import { withAdmission, withScoped } from "./scope-fixture";
import { withPlayground } from "./test-fixture";
import { nextBuildFilesystem } from "./next-build-fixture";
import { nextBuildFiles, parseBuildFile, compareBuildFiles, type FileRead } from "./next-build-files";
import { NextBuildObserver, buildNextBuildReaderSource, closeNextBuildObserver, type NextBuildObservation } from "./next-build-observer";

const next = frameworks.find(item => item.id === "next");
if (!next) throw new Error("Missing Next fixture");
const tracePath = nextBuildFiles[3].path;
const manifestPath = nextBuildFiles[1].path;
const diagnosticsPath = nextBuildFiles[0].path;
function span(traceId: string, id: number, startTime: number, name = "node-file-trace-build") { return { traceId, id, name, startTime, duration: 10, timestamp: 42, tags: { secret: "DO NOT RETAIN" } }; }
function read(path: FileRead["path"], text: string, offset = 0): Extract<FileRead, { status: "read" }> { return { path, status: "read", text, bytes: text.length, size: text.length + offset, offset, truncated: offset > 0 }; }

async function fixture<T>(action: (value: { fs: ReturnType<typeof nextBuildFilesystem>; transport: Transport; events: NextBuildObservation[] }) => Promise<T>, buildDelayMs = 350) {
  const fs = nextBuildFilesystem();
  try {
    fs.write({ [manifestPath]: '{"version":1,"files":["dev.js"]}', [tracePath]: JSON.stringify([span("dev", 1, 1)]) + "\n", [diagnosticsPath]: '{"buildStage":"dev"}' });
    return await withPlayground(next!, 0, async transport => {
      await withScoped(transport, page => page.evaluate(`
        globalThis.commands = []; globalThis.inputs = []; globalThis.lines = ['Compiled successfully'];
        const originalSubmit = playground.shell.submit.bind(playground.shell);
        playground.shell.submit = text => { commands.push(text); if (text === 'bun run build') lines.push('Compiled successfully', 'Collecting page data', 'Generating static pages'); return originalSubmit(text); };
        const originalInput = playground.shell.input.bind(playground.shell);
        playground.shell.input = text => { inputs.push(text); originalInput(text); };
        playground.term.buffer.active = { get length() { return lines.length; }, getLine(index) { return { translateToString() { return lines[index]; } }; } };
        playground.runtime = { async processes() { return { workerMemory() { return [{pid:7,parentPid:2,rootPid:2,job:1,bytes:null,directory:'PRIVATE',opaque:'SECRET'}]; }, memoryGroups() { return [{id:'group',members:2,pids:[2,7],committedBytes:131072,opaque:'SECRET'}]; } }; } };
        globalThis.__bunMemorySnapshots = async (engine, refresh) => { if (engine !== 'quickjs' || refresh !== false) throw Error('forced refresh'); return [{engine:'quickjs',id:'qjs',time:1,jsHeapBytes:null,notes:'Host snapshot was not acknowledged for this phase.',opaque:'SECRET',frozenAllocatorFailure:{bytes:4096,category:'libc.malloc',reason:'unknown'}}]; };
      `));
      return action({ fs, transport, events: [] });
    }, buildDelayMs, fs.filesystem);
  } finally { await fs.close(); }
}

test("complete trace batches keep fresh build identity separate from dev and partial tails", () => {
  const baseline = [parseBuildFile(read(tracePath, JSON.stringify([span("dev", 1, 5)]) + "\n"))];
  const text = 'fragment [{"name":"node-file-trace-build"}\n' + JSON.stringify([span("dev", 1, 5), span("production", 2, 100), span("production", 3, 101, "apply-include-excludes"), span("ignored", 4, 102, "private-event")]) + '\n[{"name":"next-build"';
  const current = parseBuildFile(read(tracePath, text, 100));
  expect(current).toMatchObject({ status: "trace", coverage: "tail", completeBatches: 1, partialBatches: 2 });
  const compared = compareBuildFiles(baseline, [current], 100);
  expect(compared[0]).toMatchObject({ freshProductionTraceIds: ["production"], spans: [expect.objectContaining({ seenInBaseline: true, afterDispatch: false }), expect.objectContaining({ afterDispatch: true }), expect.objectContaining({ name: "apply-include-excludes" })] });
  expect(JSON.stringify(compared)).not.toContain("DO NOT RETAIN");
  expect(JSON.stringify(compared)).not.toContain("private-event");
});

test("manifest identity compares complete parsed content, including equal-sized replacements", () => {
  const original = parseBuildFile(read(manifestPath, '{"version":1,"files":["dev.js"]}'));
  const fresh = parseBuildFile(read(manifestPath, '{"version":1,"files":["new.js"]}'));
  expect(compareBuildFiles([original], [fresh], 1)[0]).toMatchObject({ status: "manifest", changed: true, contentCompared: true, fileCount: 1 });
  expect(compareBuildFiles([original], [original], 1)[0]).toMatchObject({ changed: false });
  expect(parseBuildFile(read(manifestPath, '{"version":1'))).toMatchObject({ status: "partial" });
  expect(parseBuildFile({ ...read(manifestPath, '{"version":1,"files":[]}'), truncated: true })).toMatchObject({ status: "partial" });
});

test("real service reads enforce exact file bounds and retain only complete batches from a 64 KiB trace tail", async () => {
  await fixture(async ({ fs, transport, events }) => {
    fs.write({ [tracePath]: "discarded fragment".repeat(5000) + "\n" + JSON.stringify([span("production", 2, Date.now())]) + '\n[{"name":"next-build"' });
    await withAdmission(async admission => {
      const observer = new NextBuildObserver(scoped(transport, admission), admission, 1000, value => events.push(value));
      await observer.prepare();
    });
    expect(events[0]).toMatchObject({ status: "captured", files: expect.arrayContaining([expect.objectContaining({ status: "trace", coverage: "tail", completeBatches: 1, partialBatches: 2 })]) });
    expect(fs.reads).toContainEqual(expect.objectContaining({ length: 65_536, offset: expect.any(Number) }));
    expect(fs.reads.every(read => typeof read.length === "number" && read.length <= 262_144)).toBe(true);
    expect(fs.operations.every(row => ["preopen", "resolve", "stat", "read"].includes(row.operation))).toBe(true);
    expect(fs.disposed()).toBe(true);
    expect(fs.outstanding()).toBe(0);
    expect(JSON.stringify(events)).not.toContain("discarded fragment");
  }, 0);
});

test("one snapshot reads real filesystem service while the stock foreground command is pending", async () => {
  await fixture(async ({ fs, transport, events }) => {
    const evaluate = transport.evaluate.bind(transport);
    transport.evaluate = (expression, admission, options) => evaluate(expression.includes("const read = globalThis.__goalsNextBuildRead") ? `(() => { if (globalThis.__goalsCommand?.done) throw Error('Snapshot was not pending'); return (${expression}); })()` : expression, admission, options);
    const scope = Scope.open(1000);
    const page = scoped(transport, scope);
    const observer = new NextBuildObserver(page, scope, 100_850, value => events.push(value), { snapshotMs: 100_000, readBudgetMs: 200 });
    try {
      await observer.prepare();
      const dispatched = observer.dispatched.bind(observer);
      observer.dispatched = at => {
        dispatched(at);
        fs.write({ [manifestPath]: '{"version":1,"files":["new.js"]}', [tracePath]: JSON.stringify([span("production", 2, at)]) + "\n" });
      };
      const result = await scope.run(() => command(page, "bun run build", 1000, observer));
      observer.end();
      expect(result).toMatchObject({ done: true, code: 0 });
      expect(events.filter(event => event.kind === "baseline")).toHaveLength(1);
      const snapshots = events.filter(event => event.kind === "snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ status: "captured", files: expect.arrayContaining([expect.objectContaining({ status: "manifest", changed: true }), expect.objectContaining({ status: "trace", freshProductionTraceIds: ["production"] })]) });
      expect(events).toContainEqual(expect.objectContaining({ kind: "milestone", milestone: "Compiled successfully" }));
      expect(fs.disposed()).toBe(true);
      expect(JSON.stringify(events)).toContain("acknowledgement");
      expect(JSON.stringify(events)).toContain("not acknowledged");
      expect(JSON.stringify(events)).toContain('"jsHeapBytes":null');
      expect(JSON.stringify(events)).not.toContain("SECRET");
      expect(JSON.stringify(events)).not.toContain("PRIVATE");
      expect(await page.evaluate("commands")).toEqual(["bun run build"]);
      expect(await page.evaluate("inputs")).toEqual([]);
    } finally { scope.close(); await withScoped(transport, closeNextBuildObserver); }
  });
});

test.each(["absent", "invalid", "stalled"])("%s memory telemetry stays unavailable, never evidence of headroom", async mode => {
  await fixture(async ({ fs, transport, events }) => {
    await withScoped(transport, page => page.evaluate(mode === "absent" ? "delete globalThis.__bunMemorySnapshots" : mode === "invalid" ? "globalThis.__bunMemorySnapshots = async () => ({secret:'SECRET'});" : "globalThis.__bunMemorySnapshots = () => new Promise(resolve => { globalThis.releaseMemory = () => resolve([]); });"));
    try {
      await withAdmission(async admission => {
        const observer = new NextBuildObserver(scoped(transport, admission), admission, 1000, value => events.push(value), { snapshotMs: 100_000, readBudgetMs: 100 });
        await observer.prepare();
      });
      expect(events[0]).toMatchObject({ status: "captured", memory: { status: "unavailable" }, files: expect.arrayContaining([expect.objectContaining({ status: "manifest" })]) });
      expect(JSON.stringify(events)).not.toContain("SECRET");
      expect(fs.disposed()).toBe(true);
      expect(fs.outstanding()).toBe(0);
    } finally { await withScoped(transport, page => page.evaluate("globalThis.releaseMemory?.();")); }
  }, 0);
});

test("completion between a foreground poll and capture keeps its nonzero outcome without a snapshot read", async () => {
  await fixture(async ({ fs, transport, events }) => {
    await withScoped(transport, page => page.evaluate("playground.shell.submit = async text => { commands.push(text); await new Promise(resolve => { globalThis.completeBuild = () => { playground.shell.lastExit = 17; resolve(); }; }); };"));
    const evaluate = transport.evaluate.bind(transport);
    transport.evaluate = (expression, admission, options) => evaluate(expression.includes("function milestones") ? `(() => { globalThis.completeBuild?.(); return (${expression}); })()` : expression, admission, options);
    const scope = Scope.open(1000);
    const observer = new NextBuildObserver(scoped(transport, scope), scope, 101_000, value => events.push(value));
    try {
      await observer.prepare();
      const reads = fs.reads.length;
      await expect(command(scoped(transport, scope), "bun run build", 1000, observer)).rejects.toThrow("exited 17");
      expect(events).toContainEqual(expect.objectContaining({ kind: "snapshot", status: "skipped" }));
      expect(fs.reads).toHaveLength(reads);
      expect(await withScoped(transport, page => page.evaluate("commands"))).toEqual(["bun run build"]);
    } finally { scope.close(); await withScoped(transport, closeNextBuildObserver); }
  }, 0);
});

test.each(["missing", "truncated", "stalled"])("%s files remain explicit without changing a successful command", async mode => {
  await fixture(async ({ fs, transport, events }) => {
    if (mode === "missing") fs.fs.remove(manifestPath);
    if (mode === "truncated") fs.write({ [manifestPath]: '{"version":1,"files":["' + "x".repeat(280_000) + '"]}' });
    if (mode === "stalled") fs.stall();
    const scope = Scope.open(1500);
    const observer = new NextBuildObserver(scoped(transport, scope), scope, 101_500, value => events.push(value), { snapshotMs: 100_000, readBudgetMs: 150 });
    try {
      await observer.prepare();
      const result = await command(scoped(transport, scope), "bun run build", 1000, observer);
      expect(result).toMatchObject({ code: 0 });
      const baseline = events.find(value => value.kind === "baseline");
      expect(baseline).toMatchObject({ status: "captured", files: expect.arrayContaining([expect.objectContaining({ path: manifestPath, status: mode === "truncated" ? "partial" : "unavailable" })]) });
      expect(fs.disposed()).toBe(true);
      expect(await withScoped(transport, page => page.evaluate("commands"))).toEqual(["bun run build"]);
    } finally { scope.close(); await withScoped(transport, closeNextBuildObserver); }
  });
});

test("outer cancellation disposes completions before cleanup and admits no later read or guest input", async () => {
  await fixture(async ({ fs, transport, events }) => {
    const scope = Scope.open(1000);
    const observer = new NextBuildObserver(scoped(transport, scope), scope, 101_000, value => events.push(value), { snapshotMs: 100_000, readBudgetMs: 500 });
    await observer.prepare();
    fs.stall();
    const waiting = scope.run(() => command(scoped(transport, scope), "bun run build", 1000, observer));
    const abort = setTimeout(() => scope.close(new Error("outer cancellation")), 80);
    try {
      await expect(waiting).rejects.toThrow("outer cancellation");
      await withScoped(transport, closeNextBuildObserver);
      expect(fs.disposed()).toBe(true);
      await Bun.sleep(5);
      const operations = fs.operations.length;
      await Bun.sleep(100);
      expect(fs.operations).toHaveLength(operations);
      expect(fs.outstanding()).toBe(0);
      expect(await withScoped(transport, page => page.evaluate("commands"))).toEqual(["bun run build"]);
      expect(await withScoped(transport, page => page.evaluate("inputs"))).toEqual([]);
    } finally { clearTimeout(abort); scope.close(); }
  }, 250);
});

test("a clipped snapshot cannot extend the original phase deadline or start late requests", async () => {
  await fixture(async ({ fs, transport, events }) => {
    const scope = Scope.open(250);
    const observer = new NextBuildObserver(scoped(transport, scope), scope, 100_150, value => events.push(value), { snapshotMs: 100_000, readBudgetMs: 2000 });
    await observer.prepare();
    fs.stall();
    const started = Date.now();
    try {
      await expect(scope.run(() => command(scoped(transport, scope), "bun run build", 250, observer))).rejects.toThrow("Phase timed out after 250 ms");
      expect(Date.now() - started).toBeLessThan(350);
      expect(events.filter(value => value.kind === "snapshot")).toHaveLength(1);
      const snapshot = events.find(value => value.kind === "snapshot");
      if (!snapshot || !("deadline" in snapshot)) throw new Error("Missing snapshot");
      expect(snapshot.deadline).toBe(scope.deadline);
      expect(fs.disposed()).toBe(true);
      const count = fs.operations.length;
      await Bun.sleep(50);
      expect(fs.operations).toHaveLength(count);
    } finally { scope.close(); await withScoped(transport, closeNextBuildObserver); }
  }, 400);
});

test.each(["/home", "/home/user", "/home/user/.next", manifestPath])("symlink at %s is never followed", async path => {
  await fixture(async ({ fs, transport, events }) => {
    fs.symlink(path);
    await withAdmission(async admission => {
      const observer = new NextBuildObserver(scoped(transport, admission), admission, 1000, value => events.push(value));
      await observer.prepare();
      expect(fs.reads.every(read => read.ino !== fs.fs.lookup("/home/user/private.txt")?.ino)).toBe(true);
      expect(JSON.stringify(events)).not.toContain("PRIVATE MUST NOT BE READ");
    });
  }, 0);
});

test.each(["resolve", "stat"] as const)("replacement after %s preserves the checked original inode", async operation => {
  await fixture(async ({ fs, transport, events }) => {
    const expected = fs.fs.lookup(manifestPath)?.ino;
    fs.replace(manifestPath, operation);
    await withAdmission(async admission => {
      const observer = new NextBuildObserver(scoped(transport, admission), admission, 1000, value => events.push(value));
      await observer.prepare();
    });
    if (operation === "stat") expect(fs.reads.some(read => read.ino === expected)).toBe(true);
    const privateInode = fs.fs.lookup("/home/user/private.txt")?.ino;
    expect(fs.reads.every(read => read.ino !== privateInode)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE MUST NOT BE READ");
    if (operation === "stat") expect(events[0]).toMatchObject({ status: "captured", files: expect.arrayContaining([expect.objectContaining({ path: manifestPath, status: "manifest", fileCount: 1 })]) });
  }, 0);
});

test.each([false, true])("full execution retains original deadlines, cleanup and early completion, failed observer close = %s", async failedClose => {
  await fixture(async ({ fs, transport, events }) => {
    await withScoped(transport, page => page.evaluate(`const query = document.querySelector.bind(document); document.querySelector = selector => selector === '#engine' ? {value:'quickjs'} : selector === '#status' ? {textContent:'QuickJS (Wasm) ready'} : query(selector);`));
    let cleanup = false;
    const evaluate = transport.evaluate.bind(transport);
    transport.evaluate = (expression, admission, options) => {
      if (failedClose && expression.startsWith("globalThis.__goalsNextBuildClose?.()")) throw new Error("Optional observer close unavailable");
      return evaluate(expression, admission, options);
    };
    transport.cleanup = async () => { expect(fs.disposed()).toBe(true); cleanup = true; return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
    const result = await execute({ framework: next!, box: { framework: "next", engine: "quickjs", browser: "chrome" }, url: "http://fixture/?engine=quickjs", timeoutMs: 1000, buildTimeoutMs: 110_000,
      nextBuildObservation: value => events.push(value), async createTransport() { return transport; }, async saveLog() {},
    });
    expect(result.status).toBe("pass");
    expect(result.attempts[0]?.phases.find(phase => phase.phase === "build")).toMatchObject({ status: "pass", timeoutMs: 110_000 });
    expect(result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass", timeoutMs: 20_000 });
    expect(cleanup).toBe(true);
    expect(events.filter(value => value.kind === "snapshot")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "cleanup", status: failedClose ? "unavailable" : "closed" }));
    expect(await withScoped(transport, page => page.evaluate("commands.filter(text => text === 'bun run build')"))).toEqual(["bun run build"]);
  }, 0);
});

test("full execution cancels a pending baseline and disposes before owned cleanup, without a late build dispatch", async () => {
  await fixture(async ({ fs, transport, events }) => {
    await withScoped(transport, page => page.evaluate(`const query = document.querySelector.bind(document); document.querySelector = selector => selector === '#engine' ? {value:'quickjs'} : selector === '#status' ? {textContent:'QuickJS ready'} : query(selector);`));
    fs.stall();
    const controller = new AbortController();
    let abort: ReturnType<typeof setTimeout> | undefined;
    const evaluate = transport.evaluate.bind(transport);
    transport.evaluate = (expression, admission, options) => {
      if (expression.includes("const read = globalThis.__goalsNextBuildRead")) abort = setTimeout(() => controller.abort(new Error("outer cancelled")), 30);
      return evaluate(expression, admission, options);
    };
    transport.cleanup = async () => { expect(fs.disposed()).toBe(true); expect(fs.outstanding()).toBe(0); return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
    try {
      const result = await execute({ framework: next!, box: { framework: "next", engine: "quickjs", browser: "chrome" }, url: "http://fixture/?engine=quickjs", timeoutMs: 1000, buildTimeoutMs: 110_000, signal: controller.signal,
        nextBuildObservation: value => events.push(value), async createTransport() { return transport; }, async saveLog() {},
      });
      expect(result).toMatchObject({ status: "fail", phase: "build", error: expect.stringContaining("outer cancelled") });
      expect(result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass", timeoutMs: 20_000 });
      const commands = await withScoped(transport, page => page.evaluate<string[]>("commands"));
      expect(commands.filter(text => text === "bun run build")).toEqual([]);
      const reads = fs.operations.length;
      await Bun.sleep(50);
      expect(fs.operations).toHaveLength(reads);
      expect(events).toContainEqual(expect.objectContaining({ kind: "cleanup", status: "closed" }));
    } finally { clearTimeout(abort); }
  }, 0);
});

test("CLI is opt-in, one cell only, and forwarded with the original provenance and deadline policy", () => {
  const args = ["--asset-source=protected-packet", "--profile=shared-group", "--frameworks=next", "--engines=quickjs", "--browsers=safari", "--mac-lane=next-observer", "--mac-thread=mcp:105b2121-52e2-452e-b4f7-d068140c0278"];
  const plain = options(args);
  expect(plain.nextBuildObservation).toBe(false);
  const config = options(args.concat(["--next-build-observation"]));
  const forwarded = options(nativeRunnerArgs(config, "/Users/fixture/next"));
  expect(forwarded).toMatchObject({ nextBuildObservation: true, profile: "shared-group", frameworks: ["next"], engines: ["quickjs"], browsers: ["safari"], assetSource: "protected-packet" });
  expect(config.timeoutMs).toBeUndefined();
  expect(() => options(["--asset-source=unit", "--next-build-observation"])).toThrow("one Next QuickJS cell");
  expect(() => options(args.concat(["--next-build-observation=false"]))).toThrow("one Next QuickJS cell");
});

test("portable reader is embedded without an installed remote source tree", async () => {
  const source = await buildNextBuildReaderSource();
  const built = await Bun.build({ entrypoints: [new URL("./next-build-observer.ts", import.meta.url).pathname], target: "bun", define: { __GOALS_NEXT_BUILD_READER__: JSON.stringify(source) } });
  expect(built.success).toBe(true);
  expect(await built.outputs[0]?.text()).toContain("__goalsNextBuildRead");
});
