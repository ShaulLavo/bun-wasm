import { expect, test } from "bun:test";
import type { Runtime } from "waffle";
import { createContext, runInContext } from "node:vm";
import { MemFS } from "waffle/fs/memory";
import { createPrompt, type PromptContext } from "bash-web/prompt";
import { importPromptRepository, promptRepositoryFixtures, type PromptRepositoryFixture } from "./shell-prompt-fixture";
import { armPromptReadBarrier, deferredPromptSource, assertActivePromptWrap, assertPreservedDraft, installPromptReadBudget, promptReadBudgetSetup, restorePromptFixture, withPromptFixture, type PromptSnapshot } from "./shell-prompt-check";

function filesystem() {
  const calls: { receiver: unknown; path: string }[] = [];
  const source: Pick<Runtime["filesystem"], "readFile"> = {
    async readFile(this: unknown, path: string) {
      calls.push({ receiver: this, path });
      return new TextEncoder().encode("tracked");
    },
  };
  return { source, calls };
}

test("prompt read barrier preserves receiver and arguments, then restores the original method", async () => {
  const fixture = filesystem();
  const original = fixture.source.readFile;
  const barrier = armPromptReadBarrier(fixture.source, "/tracked");
  const pending = fixture.source.readFile("/tracked");
  await barrier.entered;
  expect(fixture.calls).toEqual([]);
  barrier.release();
  expect(new TextDecoder().decode(await pending)).toBe("tracked");
  expect(fixture.calls).toEqual([{ receiver: fixture.source, path: "/tracked" }]);
  barrier.restore();
  expect(fixture.source.readFile).toBe(original);
});

test("prompt read barrier restores after a rejected read", async () => {
  const source: Pick<Runtime["filesystem"], "readFile"> = {
    async readFile() { throw new Error("read failed"); },
  };
  const original = source.readFile;
  const barrier = armPromptReadBarrier(source, "/tracked");
  const pending = source.readFile("/tracked").catch(error => error);
  await barrier.entered;
  barrier.restore();
  expect(await pending).toEqual(new Error("read failed"));
  expect(source.readFile).toBe(original);
});

test("prompt barrier bypasses unrelated paths and preserves method descriptors", async () => {
  const fixture = filesystem();
  const descriptor = Object.getOwnPropertyDescriptor(fixture.source, "readFile");
  const barrier = armPromptReadBarrier(fixture.source, "/tracked");
  try {
    expect(new TextDecoder().decode(await fixture.source.readFile("/other"))).toBe("tracked");
    expect(fixture.calls).toEqual([{ receiver: fixture.source, path: "/other" }]);
  } finally { barrier.restore(); }
  expect(Object.getOwnPropertyDescriptor(fixture.source, "readFile")).toEqual(descriptor);
});

test("prompt barrier restores inherited methods and releases cancelled pending reads", async () => {
  const fixture = filesystem();
  const source: typeof fixture.source = Object.create(fixture.source);
  const barrier = armPromptReadBarrier(source, "/tracked");
  const pending = source.readFile("/tracked");
  await barrier.entered;
  expect(barrier.blocked).toBe(true);
  barrier.restore();
  await pending;
  await barrier.finished;
  expect(barrier.blocked).toBe(false);
  expect(Object.hasOwn(source, "readFile")).toBe(false);
  expect(source.readFile).toBe(fixture.source.readFile);
  barrier.restore();
});

test("the browser serializes the same self-contained barrier, not a second implementation", async () => {
  const install: typeof armPromptReadBarrier = new Function(`return (${armPromptReadBarrier.toString()});`)();
  const fixture = filesystem();
  const original = fixture.source.readFile;
  const barrier = install(fixture.source, "/tracked");
  const pending = fixture.source.readFile("/tracked");
  try {
    await barrier.entered;
    expect(fixture.calls).toEqual([]);
    barrier.release();
    await pending;
    await barrier.finished;
    expect(fixture.calls).toEqual([{ receiver: fixture.source, path: "/tracked" }]);
  } finally { barrier.restore(); }
  expect(fixture.source.readFile).toBe(original);
});

test("plain transcript helper rejects prompt-on and implicit modes before reading two-line output", async () => {
  const source = await Bun.file(new URL("./playground.mjs", import.meta.url)).text();
  const declaration = source.slice(source.indexOf("export async function run("));
  expect(declaration).toStartWith("export async function run(");
  const create = new Function("terminalText", "runForeground", `return (${declaration.replace("export ", "")});`);
  let read = false;
  const run: (page: { url(): string }, command: string) => Promise<unknown> = create(
    async () => { read = true; return "directory\n❯ command\noutput\ndirectory\n❯ "; },
    async () => { throw new Error("Must reject before submitting"); },
  );
  for (const query of ["", "?prompt=on", "?prompt=false"]) {
    await expect(run({ url: () => `https://example.test/playground/${query}` }, "true")).rejects.toThrow("requires the explicit ?prompt=off");
  }
  expect(read).toBe(false);
});

const transcriptCallers = [
  "scripts/app-matrix/browser.mjs", "scripts/app-matrix/next-acceptance.ts", "tests/esbuild/browser.mjs",
  "web/tests/bench-engines.mjs", "web/tests/bench-memory.mjs", "web/tests/browser-async-context-runtime.ts",
  "web/tests/browser-crypto.mjs", "web/tests/browser-engine.mjs", "web/tests/browser-install.mjs",
  "web/tests/browser-installer-links.ts", "web/tests/browser-memory.mjs", "web/tests/browser-module-retry.ts",
  "web/tests/browser-prepare-context.ts", "web/tests/browser-stack.mjs", "web/tests/browser-subprocess.ts",
  "web/tests/browser-tools.ts", "web/tests/browser-worker-modules.ts", "web/tests/next-framework-browser.ts",
  "web/tests/shell-stop-check.ts",
];
const nonTranscriptCallers = [
  "sandbox/tests/startup-cache.mjs", "scripts/app-matrix/isolation.test.mjs", "scripts/verify-engine-memory-browser.ts",
  "web/tests/browser-child-process-ipc.ts", "web/tests/browser-editor.ts", "web/tests/browser-next-sockets.ts",
  "web/tests/browser-type.ts", "web/tests/playground.mjs", "web/tests/shell-prompt-check.test.ts",
];
const inheritedTranscriptCallers = ["web/tests/browser-workers.ts", "web/tests/browser-web-workers.ts", "web/tests/browser-shell-stop.ts"];

test("every playground helper reader has a maintained transcript or public-state classification", async () => {
  const root = new URL("../../", import.meta.url).pathname;
  const found = Bun.spawnSync(["git", "grep", "-l", "-z", "playground.mjs", "--", "*.ts", "*.mjs", "*.js"], { cwd: root });
  expect(found.exitCode).toBe(0);
  const actual = found.stdout.toString().split("\0").filter(Boolean).sort();
  const classified = transcriptCallers.concat(nonTranscriptCallers, inheritedTranscriptCallers).sort();
  expect(actual).toEqual(classified);
  for (const path of transcriptCallers) {
    const source = await Bun.file(new URL(path, `file://${root}`)).text();
    expect(source).toMatch(/prompt=off|searchParams\.set\("prompt", "off"\)/);
  }
  const workers = await Bun.file(new URL("./browser-workers.ts", import.meta.url)).text();
  expect(workers).toContain("await run(");
  const owner = await Bun.file(new URL("./browser-web-workers.ts", import.meta.url)).text();
  expect(owner).toContain("prompt=off");
  const shellStop = await Bun.file(new URL("./browser-shell-stop.ts", import.meta.url)).text();
  expect(shellStop).toContain("shell-stop-check");
});

function snapshot(status: string, generation = "4", cursorX = 12): PromptSnapshot {
  return {
    generation, cursorX, cursorRow: 1, cols: 80,
    rows: [{ text: `repo on main ${status}`, wrapped: false, cells: [] }, { text: "❯ echo typed", wrapped: false, cells: [] }],
  };
}

for (const beforeStatus of ["", "[!]"]) {
  test(`draft/caret control accepts a legal update ordering from ${JSON.stringify(beforeStatus)}`, () => {
    expect(() => assertPreservedDraft(snapshot(beforeStatus), snapshot("[!]"))).not.toThrow();
  });
}

test("draft control rejects escaped generations, caret drift and duplicated prompts", () => {
  expect(() => assertPreservedDraft(snapshot(""), snapshot("[!]", "5"))).toThrow("generation");
  expect(() => assertPreservedDraft(snapshot(""), snapshot("[!]", "4", 11))).toThrow("caret");
  const duplicate = snapshot("[!]");
  const rows = duplicate.rows.concat([{ text: "❯ echo typed", wrapped: false, cells: [] }]);
  expect(() => assertPreservedDraft(snapshot(""), { ...duplicate, rows, cursorRow: 2 })).toThrow();
});

test("unrelated and restored reads return the exact original promise", async () => {
  const result = Promise.resolve(new Uint8Array([7]));
  const source: Pick<Runtime["filesystem"], "readFile"> = { readFile: () => result };
  const barrier = armPromptReadBarrier(source, "/tracked");
  const installed = source.readFile;
  try {
    expect(source.readFile("/other")).toBe(result);
    barrier.restore();
    expect(installed.call(source, "/tracked")).toBe(result);
  } finally { barrier.restore(); }
  await result;
});

function configFilesystem(previous?: Uint8Array) {
  const path = "/home/user/.config/bash-web/prompt.json";
  const files = new Map<string, string | Uint8Array>();
  if (previous) files.set(path, previous);
  const source: Parameters<typeof installPromptReadBudget>[0] = {
    async readFile(name) {
      const contents = files.get(name);
      return typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    },
    async writeFile(name, contents) { files.set(name, contents); },
    async remove(name) { return files.delete(name); },
    async mkdirp() {},
  };
  return { source, files, path };
}

for (const previous of [undefined, new TextEncoder().encode(' {"newline":false}\n')]) {
  test(`selected-read budget restores exact prior config bytes: ${previous !== undefined}`, async () => {
    const fixture = configFilesystem(previous);
    const restore = await installPromptReadBudget(fixture.source);
    try {
      expect(JSON.parse(new TextDecoder().decode(await fixture.source.readFile(fixture.path)))).toEqual({ backgroundMs: 60000 });
    } finally { await restore(); }
    expect(fixture.files.get(fixture.path)).toBe(previous);
  });
}

test("selected-read budget rolls back failed installation", async () => {
  const previous = new TextEncoder().encode('{"newline":false}');
  const fixture = configFilesystem(previous);
  const failure = new Error("fixture write failed");
  const original = fixture.source.writeFile;
  fixture.source.writeFile = async (path, contents) => {
    if (typeof contents === "string") throw failure;
    return original(path, contents);
  };
  await expect(installPromptReadBudget(fixture.source)).rejects.toBe(failure);
  expect(fixture.files.get(fixture.path)).toBe(previous);
});

test("serialized budget fixture preserves config and barrier cleanup waits for the held read", async () => {
  const install: typeof installPromptReadBudget = new Function(`return (${installPromptReadBudget.toString()});`)();
  const fixture = configFilesystem();
  const restore = await install(fixture.source);
  const barrier = armPromptReadBarrier(fixture.source, "/tracked");
  const pending = fixture.source.readFile("/tracked");
  await barrier.entered;
  try { throw new Error("fixture assertion failed"); }
  catch { /* Cleanup must also finish when an assertion interrupts the fixture. */ }
  finally {
    barrier.restore();
    if (barrier.blocked) await barrier.finished;
    await restore();
  }
  await pending;
  expect(barrier.blocked).toBe(false);
  expect(fixture.files.has(fixture.path)).toBe(false);
});

test("narrow-wrap control rejects historical wraps outside the active prompt", () => {
  const active = snapshot("");
  const history: PromptSnapshot["rows"][number][] = [
    { text: "old output", wrapped: false, cells: [] },
    { text: "old continuation", wrapped: true, cells: [] },
  ];
  const rows = history.concat(active.rows);
  expect(() => assertActivePromptWrap({ ...active, rows, cursorRow: 3 })).toThrow("Active narrow prompt");
  const wrapped = rows.slice(0, 3).concat([
    { text: "directory continuation", wrapped: true, cells: [] },
    { text: "❯ echo typed", wrapped: false, cells: [] },
  ]);
  expect(() => assertActivePromptWrap({ ...active, rows: wrapped, cursorRow: 4 })).not.toThrow();
  const draft = rows.concat([{ text: "typed continuation", wrapped: true, cells: [] }]);
  expect(() => assertActivePromptWrap({ ...active, rows: draft, cursorRow: 4 })).not.toThrow();
});

function providerFilesystem() {
  const memory = new MemFS();
  return {
    async lookup(path: string) { return memory.lookup(path); },
    async readFile(path: string) { return memory.readFile(path); },
    async mkdirp(path: string) { memory.mkdirp(path); },
    async writeFile(path: string, contents: string | Uint8Array) { memory.writeFile(path, contents); },
    async remove(path: string) { return memory.remove(path); },
  };
}

function providerContext(root: string, signal: AbortSignal): PromptContext {
  return {
    turn: 1, cwd: root, status: 0, pipestatus: [0], durationMs: undefined, jobs: 0,
    columns: 80, rows: 24, lineEditor: "zsh", ps1: "$ ",
    variables: new Map([["HOME", "/home/user"]]), signal,
  };
}

async function providerMarker(fixture: PromptRepositoryFixture): Promise<void> {
  const fs = providerFilesystem();
  const root = `/home/user/marker-${fixture.step}`;
  await importPromptRepository(fs, root, fixture.files);
  const provider = createPrompt({ filesystem: fs });
  const controller = new AbortController();
  const update = Promise.withResolvers<string>();
  const timeout = setTimeout(() => update.reject(new Error(`Missing provider marker: ${fixture.step}`)), 2000);
  try {
    const initial = await provider.render(providerContext(root, controller.signal), {
      signal: controller.signal, update(text) { if (fixture.pattern.test(text)) update.resolve(text); },
    });
    const prompt = fixture.pattern.test(initial ?? "") ? initial : await update.promise;
    expect(prompt).toMatch(fixture.pattern);
  } finally { clearTimeout(timeout); controller.abort(); }
}

test("host Git snapshots qualify every maintained provider marker without a guest command", async () => {
  const fixtures = await promptRepositoryFixtures();
  expect(fixtures.map(fixture => fixture.step)).toEqual([
    "branch", "detached", "modified", "deleted", "untracked", "staged", "stash",
    "ahead", "behind", "diverged", "missing upstream", "merging", "corrupt index",
  ]);
  for (const fixture of fixtures) await providerMarker(fixture);
});

test("modified fixture holds an actual provider tracked-file read before publishing its marker", async () => {
  const fixture = (await promptRepositoryFixtures()).find(state => state.step === "modified");
  expect(fixture).toBeDefined();
  if (!fixture) throw new Error("Missing modified fixture");
  const fs = providerFilesystem();
  const root = "/home/user/held-provider";
  await importPromptRepository(fs, root, fixture.files);
  const barrier = armPromptReadBarrier(fs, `${root}/tracked.txt`);
  const controller = new AbortController();
  const update = Promise.withResolvers<string>();
  const timeout = setTimeout(() => update.reject(new Error("Missing held-read marker")), 2000);
  const provider = createPrompt({ filesystem: fs });
  try {
    const initial = await provider.render(providerContext(root, controller.signal), {
      signal: controller.signal, update(text) { if (fixture.pattern.test(text)) update.resolve(text); },
    });
    await Promise.race([barrier.entered, update.promise]);
    expect(barrier.blocked).toBe(true);
    expect(initial).not.toMatch(fixture.pattern);
    barrier.release();
    expect(await update.promise).toMatch(fixture.pattern);
    await barrier.finished;
  } finally { barrier.restore(); controller.abort(); clearTimeout(timeout); }
});

for (const previous of [undefined, new TextEncoder().encode(' {"newline":false}\n')]) {
  test(`evaluated setup installs callable rollback and restores exact prior bytes: ${previous !== undefined}`, async () => {
    const fixture = configFilesystem(previous);
    const realm = createContext({ playground: { fs: fixture.source } });
    await runInContext(promptReadBudgetSetup(), realm);
    expect(typeof Reflect.get(realm, "restorePromptReadBudget")).toBe("function");
    expect(fixture.files.get(fixture.path)).toBe('{"backgroundMs":60000}');
    await runInContext(`(${restorePromptFixture.toString()})()`, realm);
    expect(fixture.files.get(fixture.path)).toBe(previous);
    expect(Object.hasOwn(realm, "restorePromptReadBudget")).toBe(false);
  });
}

test("evaluated cleanup drains the held read before restoring configuration and clearing globals", async () => {
  const fixture = configFilesystem();
  const order: string[] = [];
  const original = fixture.source.readFile;
  fixture.source.readFile = async path => {
    if (path === "/tracked") order.push("read finished");
    return original(path);
  };
  const realm = createContext({ playground: { fs: fixture.source } });
  await runInContext(promptReadBudgetSetup(), realm);
  const restore: unknown = Reflect.get(realm, "restorePromptReadBudget");
  if (typeof restore !== "function") throw new Error("Setup was not invoked");
  Reflect.set(realm, "restorePromptReadBudget", async () => { order.push("restore config"); await restore(); });
  const barrier = armPromptReadBarrier(fixture.source, "/tracked");
  Reflect.set(realm, "promptReadBarrier", barrier);
  const pending = fixture.source.readFile("/tracked");
  await barrier.entered;
  try { await runInContext(`(${restorePromptFixture.toString()})()`, realm); }
  finally { barrier.restore(); await pending; }
  expect(order).toEqual(["read finished", "restore config"]);
  expect(barrier.blocked).toBe(false);
  expect(fixture.files.has(fixture.path)).toBe(false);
  expect(Object.hasOwn(realm, "promptReadBarrier")).toBe(false);
});

for (const previous of [undefined, new TextEncoder().encode("{}\n")]) {
  test(`failure cleanup restores config, drains reads and resets the directory: ${previous !== undefined}`, async () => {
    const fixture = configFilesystem(previous);
    const realm = createContext({ playground: { fs: fixture.source } });
    const primary = new Error("original fixture failure");
    let reset = false;
    const action = async () => {
      await runInContext(promptReadBudgetSetup(), realm);
      throw primary;
    };
    const barrier = armPromptReadBarrier(fixture.source, "/tracked");
    const pending = fixture.source.readFile("/tracked");
    await barrier.entered;
    Reflect.set(realm, "promptReadBarrier", barrier);
    const clean = async () => { await runInContext(`(${restorePromptFixture.toString()})()`, realm); };
    const resetDirectory = async () => { reset = true; };
    try { await expect(withPromptFixture(action, [clean, resetDirectory])).rejects.toBe(primary); }
    finally { barrier.restore(); await pending; }
    expect(reset).toBe(true);
    expect(barrier.blocked).toBe(false);
    expect(fixture.files.get(fixture.path)).toBe(previous);
  });
}

test("cleanup failures preserve the original cause and do not skip later cleanup", async () => {
  const primary = new Error("original fixture failure");
  const cleanup = new Error("rollback failed");
  let reset = false;
  const action = async () => { throw primary; };
  const clean = async () => { throw cleanup; };
  const error = await withPromptFixture(action, [clean, async () => { reset = true; }]).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw error;
  expect(error.cause).toBe(primary);
  expect(error.errors).toEqual([primary, cleanup]);
  expect(reset).toBe(true);
});

test("budget rollback failure retains installation failure as its first cause", async () => {
  const fixture = configFilesystem(new TextEncoder().encode("{}"));
  const primary = new Error("install failed");
  const cleanup = new Error("rollback failed");
  fixture.source.writeFile = async (_path, contents) => { throw typeof contents === "string" ? primary : cleanup; };
  const error = await installPromptReadBudget(fixture.source).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw error;
  expect(error.cause).toBe(primary);
  expect(error.errors).toEqual([primary, cleanup]);
});

test("serialized cleanup forgets globals even when budget restoration fails", async () => {
  const fixture = configFilesystem();
  const realm = createContext({ playground: { fs: fixture.source } });
  await runInContext(promptReadBudgetSetup(), realm);
  Reflect.set(realm, "restorePromptReadBudget", async () => { throw new Error("rollback failed"); });
  Reflect.set(realm, "promptCapture", "fixture-owned");
  await expect(runInContext(`(${restorePromptFixture.toString()})()`, realm)).rejects.toThrow("rollback failed");
  expect(Object.hasOwn(realm, "restorePromptReadBudget")).toBe(false);
  expect(Object.hasOwn(realm, "promptCapture")).toBe(false);
});

test("cleanup releases and drains a read even when method restoration throws", async () => {
  const fixture = filesystem();
  const barrier = armPromptReadBarrier(fixture.source, "/tracked");
  const pending = fixture.source.readFile("/tracked");
  await barrier.entered;
  const primary = new Error("method restore failed");
  let budgetRestored = false;
  const realm = createContext({
    promptReadBarrier: { ...barrier, restore() { throw primary; } },
    restorePromptReadBudget: async () => { budgetRestored = true; },
  });
  try { await expect(runInContext(`(${restorePromptFixture.toString()})()`, realm)).rejects.toBe(primary); }
  finally { barrier.restore(); await pending; }
  expect(budgetRestored).toBe(true);
  expect(barrier.blocked).toBe(false);
  expect(Object.hasOwn(realm, "promptReadBarrier")).toBe(false);
});


test("status transport barrier holds and releases the original request without changing frozen capabilities", async () => {
  const fs = Object.freeze(filesystem().source);
  const before = Object.getOwnPropertyDescriptors(fs);
  const source = deferredPromptSource();
  let calls = 0;
  const request = source.hold("https://example.test/chunks/status-original.js", async () => { calls++; });
  await source.entered;
  expect(calls).toBe(0);
  expect(source.urls).toEqual(["https://example.test/chunks/status-original.js"]);
  source.release();
  await request;
  await source.drain();
  expect(calls).toBe(1);
  expect(Object.getOwnPropertyDescriptors(fs)).toEqual(before);
});

test("status transport cleanup releases held requests and preserves the original transport failure", async () => {
  const source = deferredPromptSource();
  const failure = new Error("original transport failure");
  const request = source.hold("https://example.test/chunks/status-original.js", async () => { throw failure; });
  void request.catch(() => {});
  await source.entered;
  await expect(source.drain()).rejects.toBe(failure);
});
