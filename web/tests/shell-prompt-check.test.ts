import { expect, test } from "bun:test";
import type { Runtime } from "waffle";
import { armPromptReadBarrier, assertPreservedDraft, type PromptSnapshot } from "./shell-prompt-check";

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
