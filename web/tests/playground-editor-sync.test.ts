import { afterEach, expect, test } from "bun:test";
import { deferred, filesystem, filesystemFixture, models } from "./ui-model-helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

test("Playground Editor tracks monotonic revisions, overlapping saves, deferredSync, folder prefixes, and deletion fallback", async () => {
  const fixture = filesystemFixture();
  fixture.files.set("/home/user/index.ts", "console.log('v1');");
  fixture.files.set("/home/user/sub/helper.ts", "export const x = 1;");
  fixture.directories.add("/home/user");
  fixture.directories.add("/home/user/sub");

  const page = await models(fixture);
  cleanups.push(page.cleanup);

  let nextSaveGate: ReturnType<typeof deferred<void>> | null = null;
  const savedWrites: Array<{ path: string; text: string }> = [];
  const editor = new page.PlaygroundEditor(filesystem(fixture), {
    run: async () => {},
    report(err) { throw err; },
    changed() {},
    async saveFile(path: string, text: string) {
      const gate = nextSaveGate;
      nextSaveGate = null;
      if (gate) await gate.promise;
      savedWrites.push({ path, text });
      fixture.files.set(path, text);
    },
  });

  await editor.open("/home/user/index.ts");
  expect(editor.view.state.doc.toString()).toBe("console.log('v1');");
  expect(editor.dirty(editor.path)).toBe(false);

  // Clean external edit via syncPaths updates buffer automatically.
  fixture.files.set("/home/user/index.ts", "console.log('v2-from-peer');");
  await editor.syncPaths(["index.ts"]);
  expect(editor.view.state.doc.toString()).toBe("console.log('v2-from-peer');");

  // Overlapping save: start save #1 (blocked), trigger syncPaths while in-flight, type edit #2 before save #1 finishes.
  const gate1 = deferred<void>();
  nextSaveGate = gate1;
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "console.log('local-1');" } });
  const save1 = editor.save();

  // External change notification during in-flight save defers reconciliation until save settles.
  await editor.syncPaths(["index.ts"]);

  // User types a second edit while save #1 is in flight -> dirty must stay true after save #1 finishes!
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "console.log('local-2');" } });
  gate1.resolve();
  await save1;
  expect(editor.dirty(editor.path)).toBe(true);
  expect(editor.view.state.doc.toString()).toBe("console.log('local-2');");

  // External change while dirty must NOT clobber local unsaved buffer!
  fixture.files.set("/home/user/index.ts", "console.log('peer-edit');");
  await editor.syncPaths(["index.ts"]);
  expect(editor.view.state.doc.toString()).toBe("console.log('local-2');");
  expect(editor.dirty(editor.path)).toBe(true);

  // Explicit save writes local-2 cleanly.
  await editor.save();
  expect(editor.dirty(editor.path)).toBe(false);
  expect(fixture.files.get("/home/user/index.ts")).toBe("console.log('local-2');");

  // Folder-prefix matching: directory-level change ("sub") updates open file inside "/home/user/sub/helper.ts".
  await editor.open("/home/user/sub/helper.ts");
  fixture.files.set("/home/user/sub/helper.ts", "export const x = 2;");
  await editor.syncPaths(["sub"]);
  expect(editor.view.state.doc.toString()).toBe("export const x = 2;");

  // Active clean deletion falls back to another existing file, and handles 0 files cleanly.
  fixture.files.delete("/home/user/sub/helper.ts");
  await editor.syncPaths(["sub/helper.ts"]);
  expect(editor.path).toBe("/home/user/index.ts");

  fixture.files.delete("/home/user/index.ts");
  await editor.syncFromFs();
  expect(editor.path).toBe("");
  expect(editor.view.state.doc.toString()).toBe("");
});
