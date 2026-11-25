import { afterEach, expect, test } from "bun:test";
import { deferred, filesystemFixture, models } from "../web/tests/ui-model-helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

test("Sandbox Editor reconciles clean buffers, tracks resetGeneration conflicts, pauses autosave during reset, and coalesces flushes", async () => {
  const fixture = filesystemFixture();
  const page = await models(fixture);
  cleanups.push(page.cleanup);

  const files = new Map<string, string>([
    ["src/App.tsx", "export default 'v1';"],
    ["src/Other.ts", "export const n = 1;"],
  ]);
  let resetGen = 0;
  let resetting = false;
  const savedCalls: Array<{ path: string; text: string; editResetGen: number; resolveConflict?: boolean }> = [];
  let blockSave: ReturnType<typeof deferred<void>> | null = null;

  const editor = new page.SandboxEditor({
    app: "/home/user/app",
    async readFile(path: string) {
      return { text: files.get(path) ?? null, resetGeneration: resetGen };
    },
    async listFiles() {
      return Array.from(files.keys()).sort();
    },
    async save(path, text, _rev, editResetGen, options) {
      const gate = blockSave;
      blockSave = null;
      if (gate) await gate.promise;
      if (!options?.resolveConflict && editResetGen !== resetGen) {
        const err = new Error("Reset generation mismatch");
        err.name = "ResetGenerationMismatchError";
        throw err;
      }
      savedCalls.push({ path, text, editResetGen, resolveConflict: options?.resolveConflict });
      files.set(path, text);
    },
    async checkpoint() {},
    currentResetGeneration: () => resetGen,
    isResetting: () => resetting,
    changed() {},
  });

  await editor.open("src/App.tsx");
  expect(editor.path).toBe("src/App.tsx");
  expect(editor.view.state.doc.toString()).toBe("export default 'v1';");

  // External clean update advances buffer and keeps bufferResetGen current.
  files.set("src/App.tsx", "export default 'v2-peer';");
  await editor.syncPaths(["src/App.tsx"]);
  expect(editor.view.state.doc.toString()).toBe("export default 'v2-peer';");
  expect(editor.conflicted.has("src/App.tsx")).toBe(false);

  // Dirty edit + reset generation bump marks ONLY dirty buffer conflicted and pauses autosave.
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "export default 'dirty-local';" } });
  resetting = true;
  editor.suspendAutosaveForReset();
  resetGen = 1;
  files.set("src/App.tsx", "export default 'reset-template';");
  resetting = false;
  await editor.syncFromFs();
  expect(editor.conflicted.has("src/App.tsx")).toBe(true);
  expect(editor.view.state.doc.toString()).toBe("export default 'dirty-local';");

  // resumeAfterReset unpauses non-conflicted buffers while conflicted buffer still requires explicit resolveConflict.
  editor.resumeAfterReset();
  await editor.flush("src/App.tsx", { resolveConflict: true });
  expect(editor.conflicted.has("src/App.tsx")).toBe(false);
  expect(files.get("src/App.tsx")).toBe("export default 'dirty-local';");
  expect(savedCalls.at(-1)?.resolveConflict).toBe(true);

  // Duplicate flush coalescing while a save is already in flight.
  const gate = deferred<void>();
  blockSave = gate;
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "export default 'coalesced';" } });
  const f1 = editor.flush("src/App.tsx");
  const f2 = editor.flush("src/App.tsx");
  gate.resolve();
  await Promise.all([f1, f2]);
  expect(files.get("src/App.tsx")).toBe("export default 'coalesced';");

  // markAllOpenConflicted marks open buffers conflicted, and discard() clears path = "".
  editor.markAllOpenConflicted();
  expect(editor.conflicted.has("src/App.tsx")).toBe(true);
  editor.discard();
  expect(editor.path).toBe("");
  expect(editor.conflicted.size).toBe(0);
});

test("Sandbox Editor invalidates pending loads cleanly and falls back when active clean file is deleted", async () => {
  const fixture = filesystemFixture();
  const page = await models(fixture);
  cleanups.push(page.cleanup);

  const files = new Map<string, string>([
    ["src/App.tsx", "export default 'app';"],
    ["src/Fallback.ts", "export const fallback = true;"],
  ]);
  const slowRead = deferred<string>();
  let useSlow = true;

  const editor = new page.SandboxEditor({
    app: "/home/user/app",
    async readFile(path: string) {
      if (path === "src/App.tsx" && useSlow) {
        useSlow = false;
        return { text: await slowRead.promise, resetGeneration: 0 };
      }
      return { text: files.get(path) ?? null, resetGeneration: 0 };
    },
    async listFiles() {
      return Array.from(files.keys()).sort();
    },
    async save(path, text) { files.set(path, text); },
    async checkpoint() {},
    currentResetGeneration: () => 0,
    isResetting: () => false,
    changed() {},
  });

  const openPending = editor.open("src/App.tsx");
  editor.invalidatePendingLoads();
  files.set("src/App.tsx", "export default 'refreshed-after-invalidation';");
  slowRead.resolve("export default 'stale';");
  await openPending;
  // Invalidated load must NOT adopt stale bytes; a subsequent open loads the fresh content.
  expect(editor.view.state.doc.toString()).not.toBe("export default 'stale';");
  await editor.open("src/App.tsx");
  expect(editor.view.state.doc.toString()).toBe("export default 'refreshed-after-invalidation';");

  // Active clean file deletion switches cleanly to remaining file, then empty when 0 remain.
  files.delete("src/App.tsx");
  await editor.syncPaths(["src/App.tsx"]);
  expect(editor.path).toBe("src/Fallback.ts");

  files.delete("src/Fallback.ts");
  await editor.syncFromFs();
  expect(editor.path).toBe("");
});
