import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { SharedFilesystem } from "waffle/browser/shared-fs";
import { FilesystemClient, FilesystemError, FilesystemService, MemoryBackend, createFilesystemConnection } from "waffle/fs";
import { deferred, filesystem, filesystemFixture as pageFilesystem, method, models, turn } from "./ui-model-helpers";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const pageCleanups: (() => Promise<void>)[] = [];
const projectPackage = JSON.stringify({ scripts: { dev: "vite", build: "vite build" } });
afterEach(async () => { for (const cleanup of pageCleanups.splice(0)) await cleanup(); });

async function pageFixture(sources?: Record<string, string>, fixture = pageFilesystem()) {
  const page = await models(fixture, sources);
  pageCleanups.push(page.cleanup);
  return page;
}

async function editorFixture(app: "web" | "sandbox") {
  const page = await pageFixture();
  const { fixture } = page;
  fixture.control.holdWrites = true;
  fixture.fs.readFile = async path => fixture.reads.get(path)?.promise ?? encoder.encode(path);
  const playgroundEditor = new page.PlaygroundEditor(filesystem(fixture), { run: async () => {}, report(error) { throw error; }, changed() {} });
  const sandbox = new page.Sandbox("");
  sandbox.start();
  const sandboxEditor = sandbox.editor!;
  pageCleanups.push(async () => { sandboxEditor.discard(); });
  const statuses: string[] = [];
  sandbox.addEventListener("change", () => { statuses.push(sandboxEditor.saveState.text); });
  const editor = app === "web" ? playgroundEditor : sandboxEditor;
  return {
    ...page, editor, playgroundEditor, sandboxEditor, sandbox,
    save: (path: string) => app === "web" ? playgroundEditor.save() : sandboxEditor.flush(path),
    statuses,
  };
}

for (const app of ["web", "sandbox"] as const) {
  describe(`${app} async editor`, () => {
    const path = (name: string) => app === "web" ? `/home/user/${name}` : name;
    const absolute = (name: string) => app === "web" ? `/home/user/${name}` : `/home/user/app/${name}`;

    test("the latest open wins without saving the previous view under a pending path", async () => {
      const { editor, fixture: { reads } } = await editorFixture(app);
      await editor.open(path("initial.ts"));
      editor.view.setState(EditorState.create({ doc: "unsaved initial" }));
      const older = deferred<Uint8Array | undefined>();
      const newer = deferred<Uint8Array | undefined>();
      reads.set(absolute("older.ts"), older);
      reads.set(absolute("newer.ts"), newer);
      const a = editor.open(path("older.ts"));
      const b = editor.open(path("newer.ts"));
      expect(editor.path).toBe(path("initial.ts"));
      newer.resolve(encoder.encode("newer"));
      await b;
      older.resolve(encoder.encode("older"));
      await a;
      expect(editor.path).toBe(path("newer.ts"));
      expect(editor.view.state.doc.toString()).toBe("newer");
      await editor.open(path("initial.ts"));
      expect(editor.view.state.doc.toString()).toBe("unsaved initial");
    });

    test("selecting the current file cancels an outstanding open", async () => {
      const { editor, fixture: { reads } } = await editorFixture(app);
      await editor.open(path("initial.ts"));
      const pending = deferred<Uint8Array | undefined>();
      reads.set(absolute("pending.ts"), pending);
      const opening = editor.open(path("pending.ts"));
      await editor.open(path("initial.ts"));
      pending.resolve(encoder.encode("pending"));
      await opening;
      expect(editor.path).toBe(path("initial.ts"));
    });
  });
}

test("playground save completion belongs to its original file, not the newly selected tab", async () => {
  const { playgroundEditor: editor, fixture: { writes } } = await editorFixture("web");
  await editor.open("/home/user/a.ts");
  editor.view.setState(EditorState.create({ doc: "edited A" }));
  const saving = editor.save();
  await editor.open("/home/user/b.ts");
  writes[0]!.done.resolve();
  await saving;
  expect(writes[0]!.path).toBe("/home/user/a.ts");
  await editor.open("/home/user/a.ts");
  expect(editor.view.state.doc.toString()).toBe("edited A");
  expect(editor.dirty("/home/user/a.ts")).toBe(false);
  await editor.open("/home/user/b.ts");
  expect(editor.view.state.doc.toString()).toBe("/home/user/b.ts");
  expect(editor.dirty("/home/user/b.ts")).toBe(false);
});

for (const app of ["web", "sandbox"] as const) {
  test(`${app} save stays dirty until its durable checkpoint resolves`, async () => {
    const { editor, playgroundEditor, sandboxEditor, statuses, save, fixture: { writes, checkpoints } } = await editorFixture(app);
    const path = app === "web" ? "/home/user/a.ts" : "src/main.ts";
    await editor.open(path);
    editor.view.setState(EditorState.create({ doc: "durable edit" }));
    const checkpoint = deferred<void>();
    checkpoints.push(checkpoint);
    let completed = false;
    const saving = save(path).then(() => { completed = true; });
    writes[0]!.done.resolve();
    await turn();
    expect(completed).toBe(false);
    if (app === "web") expect(playgroundEditor.dirty(path)).toBe(true);
    else expect(statuses).not.toContain("saved");
    checkpoint.resolve();
    await saving;
    expect(editor.view.state.doc.toString()).toBe("durable edit");
    if (app === "web") expect(playgroundEditor.dirty(path)).toBe(false);
    else expect(sandboxEditor.saveState).toEqual({ text: "saved", kind: "ok" });
  });

  test(`${app} failed durability checkpoint never marks the edit saved`, async () => {
    const { editor, playgroundEditor, sandboxEditor, statuses, save, fixture: { writes, checkpoints } } = await editorFixture(app);
    const path = app === "web" ? "/home/user/a.ts" : "src/main.ts";
    await editor.open(path);
    editor.view.setState(EditorState.create({ doc: "must remain dirty" }));
    const checkpoint = deferred<void>();
    checkpoints.push(checkpoint);
    const saving = save(path).catch((error: unknown) => error);
    writes[0]!.done.resolve();
    await turn();
    checkpoint.reject(new Error("storage full"));
    expect(await saving).toEqual(new Error("storage full"));
    if (app === "web") expect(playgroundEditor.dirty(path)).toBe(true);
    else expect(sandboxEditor.saveState).toEqual({ text: "not saved: Error: storage full", kind: "error" });
    expect(statuses).not.toContain("saved");
  });
}

test("playground sync preserves edits made while a filesystem read is pending", async () => {
  const { playgroundEditor: editor, fixture: { reads } } = await editorFixture("web");
  await editor.open("/home/user/a.ts");
  const reading = deferred<Uint8Array | undefined>();
  reads.set("/home/user/a.ts", reading);
  const syncing = editor.syncFromFs();
  editor.view.setState(EditorState.create({ doc: "typed during read" }));
  reading.resolve(encoder.encode("external change"));
  await syncing;
  expect(editor.view.state.doc.toString()).toBe("typed during read");
});

test("sandbox reset cancels debounced writes and locks the editor before replacing files", async () => {
  const { sandboxEditor: editor, fixture: { writes } } = await editorFixture("sandbox");
  await editor.open("src/main.ts");
  editor.setText("pending edit");
  const timers: unknown = Reflect.get(editor, "timers");
  expect(timers).toBeInstanceOf(Map);
  expect(timers instanceof Map && timers.size).toBe(1);
  editor.discard();
  expect(timers instanceof Map && timers.size).toBe(0);
  expect(editor.view.state.readOnly).toBe(true);
  expect(writes).toEqual([]);
});

test("sandbox reset waits for the stopped guest and durable template before reloading", async () => {
  const page = await pageFixture({ "index.html": "template", "package.json": projectPackage });
  const sandbox = new page.Sandbox("");
  sandbox.start();
  const stopped = deferred<{ code: number }>();
  const checkpoint = deferred<void>();
  const events: string[] = [];
  const discard = sandbox.editor!.discard.bind(sandbox.editor);
  spyOn(sandbox.editor!, "discard").mockImplementation(() => { events.push("discard"); discard(); });
  Reflect.set(sandbox, "run", { done: stopped.promise, kill() { events.push("stop"); } });
  page.boundary.fetch = async () => { events.push("template:true"); return new Response(JSON.stringify({ files: { "index.html": "template", "package.json": projectPackage } })); };
  page.boundary.location.reload = () => { events.push("reload"); };
  page.fixture.checkpoints.push(checkpoint);
  const resetting = sandbox.reset();
  expect(sandbox.resetting).toBe(true);
  expect(events).toEqual(["discard", "stop"]);
  stopped.resolve({ code: 0 });
  await turn();
  expect(events).toEqual(["discard", "stop", "template:true"]);
  checkpoint.resolve();
  await resetting;
  expect(events).toEqual(["discard", "stop", "template:true", "reload"]);
});

test("sandbox reports failed filesystem saves and rejects explicit flush", async () => {
  const { sandboxEditor: editor, fixture: { writes } } = await editorFixture("sandbox");
  await editor.open("src/main.ts");
  const saving = editor.flush("src/main.ts");
  writes[0]!.done.reject(new Error("filesystem unavailable"));
  await expect(saving).rejects.toThrow("filesystem unavailable");
  expect(editor.saveState).toEqual({ text: "not saved: Error: filesystem unavailable", kind: "error" });
});

test("sandbox stale durability replies do not replace the latest save status", async () => {
  const { sandbox, sandboxEditor: editor, fixture } = await editorFixture("sandbox");
  fixture.control.holdWrites = false;
  await editor.open("file.ts");
  editor.setText("first");
  editor.setText("second");
  const checkpoint = deferred<void>();
  const statuses: string[] = [];
  sandbox.addEventListener("change", () => { if (editor.saveState.text !== "editing…") statuses.push(editor.saveState.text); });
  const save = method<(fs: ReturnType<typeof filesystem>, path: string, text: string, revision: number) => Promise<void>>(sandbox, "save");
  fixture.checkpoints.push(checkpoint);
  const older = save(filesystem(fixture), "file.ts", "first", 1);
  await turn();
  expect(statuses).toEqual([]);
  await save(filesystem(fixture), "file.ts", "second", 2);
  expect(statuses).toEqual(["saved"]);
  checkpoint.resolve();
  await older;
  expect(statuses).toEqual(["saved"]);
  expect(fixture.files.get("/home/user/app/file.ts")).toBe("second");
});

async function seedPlayground(page: Awaited<ReturnType<typeof pageFixture>>) {
  const playground = new page.Playground("");
  void playground.start();
  await turn();
  return playground;
}

test("playground only seeds examples in a new home, preserving changes and deletions on reload", async () => {
  const page = await pageFixture();
  const { files, control } = page.fixture;
  await seedPlayground(page);
  expect(files.get("/home/user/index.ts")).toBe("example");
  expect(control.checkpoints).toBe(1);
  files.set("/home/user/index.ts", "saved edit");
  files.delete("/home/user/deleted.ts");
  await seedPlayground(page);
  expect(files.get("/home/user/index.ts")).toBe("saved edit");
  expect(files.has("/home/user/deleted.ts")).toBe(false);
  expect(control.checkpoints).toBe(1);
});

test("persisted pagehide keeps shared-object installation for the next command", async () => {
  const page = await pageFixture();
  await seedPlayground(page);
  expect(page.listeners.length).toBeGreaterThan(0);
  for (const listener of page.listeners) listener({ persisted: true });
  const nextCommand = page.runtimeSharedObjectRoute(page.runtime);
  expect(nextCommand).toBeDefined();
  nextCommand!.close();
  for (const listener of page.listeners) listener({ persisted: false });
  expect(page.runtimeSharedObjectRoute(page.runtime)).toBeUndefined();
});

test("sandbox reload preserves its workspace and only an explicit reset replaces the template", async () => {
  const template = { "index.html": "original page", "src/main.ts": "original code", "removed.ts": "remove me", "package.json": projectPackage };
  const page = await pageFixture(template);
  const { files, control } = page.fixture;
  const load = (reset = false) => page.loadTemplate(filesystem(page.fixture), "/home/user/app", "template.json", reset);
  await load();
  expect(files.get("/home/user/app/src/main.ts")).toBe("original code");
  expect(control.checkpoints).toBe(1);
  files.set("/home/user/app/src/main.ts", "saved edit");
  files.delete("/home/user/app/removed.ts");
  files.set("/home/user/app/custom.ts", "new file");
  files.set("/home/user/app/package.json", '{"edited":true}');
  await load();
  expect(files.get("/home/user/app/src/main.ts")).toBe("saved edit");
  expect(files.has("/home/user/app/removed.ts")).toBe(false);
  expect(files.get("/home/user/app/custom.ts")).toBe("new file");
  expect(control.checkpoints).toBe(1);
  await load(true);
  expect(files.get("/home/user/app/src/main.ts")).toBe("original code");
  expect(files.has("/home/user/app/removed.ts")).toBe(true);
  expect(files.has("/home/user/app/custom.ts")).toBe(false);
  expect(control.checkpoints).toBe(2);
});

for (const app of ["web", "sandbox"] as const) {
  test(`${app} reload retries a seed interrupted after its directory and first file persisted`, async () => {
    const sources = { "index.html": "page", "first.ts": "first file", "second.ts": "second file", "package.json": projectPackage };
    const page = await pageFixture(sources);
    const { fs, files, control } = page.fixture;
    const workspace = app === "web" ? "/home/user" : "/home/user/app";
    const startup = async () => {
      if (app === "sandbox") return page.loadTemplate(filesystem(page.fixture), workspace, "template.json");
      const model = await seedPlayground(page);
      if (model.failure) throw new Error(model.status.text);
    };
    control.beforeWrite = path => { if (path.endsWith("/second.ts")) throw new Error("interrupted seed"); };
    await expect(startup()).rejects.toThrow("interrupted seed");
    expect(await fs.lookup(workspace)).toBeDefined();
    expect(files.get(`${workspace}/first.ts`)).toBe("first file");
    expect(files.has(`${workspace}/second.ts`)).toBe(false);
    control.beforeWrite = undefined;
    await startup();
    expect(files.get(`${workspace}/second.ts`)).toBe("second file");
    expect(control.checkpoints).toBe(1);
    files.delete(`${workspace}/first.ts`);
    await startup();
    expect(files.has(`${workspace}/first.ts`)).toBe(false);
  });
}

test("sandbox reload completes a reset interrupted after persisting only part of its template", async () => {
  const page = await pageFixture({ "index.html": "template page", "first.ts": "template first", "second.ts": "template second", "package.json": projectPackage });
  const { files, control } = page.fixture;
  const load = (reset = false) => page.loadTemplate(filesystem(page.fixture), "/home/user/app", "template.json", reset);
  await load();
  files.set("/home/user/app/first.ts", "user edit");
  files.set("/home/user/app/custom.ts", "custom file");
  control.beforeWrite = path => { if (path.endsWith("/second.ts")) throw new Error("interrupted reset"); };
  await expect(load(true)).rejects.toThrow("interrupted reset");
  expect(files.get("/home/user/app/first.ts")).toBe("template first");
  expect(files.has("/home/user/app/second.ts")).toBe(false);
  control.beforeWrite = undefined;
  await load();
  expect(files.get("/home/user/app/second.ts")).toBe("template second");
  expect(files.has("/home/user/app/custom.ts")).toBe(false);
  files.delete("/home/user/app/first.ts");
  await load();
  expect(files.has("/home/user/app/first.ts")).toBe(false);
});

test("sandbox confirms durable saves without replaying edits through the network helper", async () => {
  const { sandbox, sandboxEditor: editor, fixture } = await editorFixture("sandbox");
  fixture.control.holdWrites = false;
  const checkpoint = deferred<void>();
  const failure = new Error("durability unavailable");
  const notifications: string[] = [];
  Reflect.set(sandbox, "server", { updates: Promise.resolve(), helper: { notifyFileChanged: async (path: string) => { notifications.push(path); } } });
  fixture.checkpoints.push(checkpoint);
  await editor.open("file.ts");
  editor.view.setState(EditorState.create({ doc: "new text" }));
  const saving = editor.flush("file.ts");
  await turn();
  expect(notifications).toEqual([]);
  checkpoint.resolve();
  await saving;
  expect(notifications).toEqual([]);
  fixture.fs.flush = async () => { throw failure; };
  await expect(editor.flush("file.ts")).rejects.toBe(failure);
  expect(notifications).toEqual([]);
});

class ControlledFilesystemBackend extends MemoryBackend {
  readonly writeEntered = deferred<void>();
  readonly flushEntered = deferred<void>();
  write: Promise<void> | undefined;
  checkpoint = Promise.resolve();
  prepare(operation: string): Promise<void> | undefined {
    if (operation !== "writeFile" || !this.write) return;
    const pending = this.write;
    this.write = undefined;
    this.writeEntered.resolve();
    return pending;
  }
  flush(): Promise<void> {
    this.flushEntered.resolve();
    return this.checkpoint;
  }
}

const filesystemCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of filesystemCleanups.splice(0)) await cleanup();
});

function filesystemFixture() {
  const connection = createFilesystemConnection();
  const backend = new ControlledFilesystemBackend();
  const service = new FilesystemService(backend);
  const client = new FilesystemClient(connection.client);
  const operations: string[] = [];
  const asyncCall = client.asyncCall.bind(client);
  const requests = spyOn(client, "asyncCall").mockImplementation((...args) => {
    operations.push(args[0]);
    return asyncCall(...args);
  });
  const fs: SharedFilesystem = Object.assign(Object.create(SharedFilesystem.prototype), {
    client, writes: Promise.resolve(),
  });
  filesystemCleanups.push(async () => {
    requests.mockRestore();
    try { await service.drainForOwner(); }
    finally {
      client.dispose();
      service.dispose();
      connection.server.port.close();
    }
  });
  service.connect(connection.server);
  return { fs, backend, operations };
}

test("shared filesystem reads drain writes without requesting storage checkpoints", async () => {
  const { fs, backend, operations } = filesystemFixture();
  const write = deferred<void>();
  backend.write = write.promise;
  const writing = fs.writeFile("/file", "memory-first");
  const reading = fs.readFile("/file");
  const lookup = fs.lookup("/file");
  const listing = fs.listFiles();
  try {
    await backend.writeEntered.promise;
    expect(operations).toEqual(["writeFile"]);
    write.resolve();
    const [, contents, entry, files] = await Promise.all([writing, reading, lookup, listing]);
    expect(operations).toEqual(["writeFile", "readFile", "lookup", "listFiles"]);
    expect(decoder.decode(contents)).toBe("memory-first");
    expect(entry?.kind).toBe("file");
    expect(files).toContain("/file");
  } finally { write.resolve(); }
});

test("shared filesystem flush waits for pending writes and a durable service checkpoint", async () => {
  const { fs, backend, operations } = filesystemFixture();
  const write = deferred<void>();
  const checkpoint = deferred<void>();
  backend.write = write.promise;
  backend.checkpoint = checkpoint.promise;
  const writing = fs.writeFile("/file", "durable");
  let completed = false;
  const saving = fs.flush().then(() => { completed = true; });
  try {
    await backend.writeEntered.promise;
    expect(operations).toEqual(["writeFile"]);
    write.resolve();
    await writing;
    await backend.flushEntered.promise;
    expect(operations).toEqual(["writeFile", "flush"]);
    expect(completed).toBe(false);
    checkpoint.resolve();
    await saving;
    expect(completed).toBe(true);
    expect(decoder.decode(await fs.readFile("/file"))).toBe("durable");
  } finally { write.resolve(); checkpoint.resolve(); }
});

test("shared filesystem flush reports failed writes and permits later writes", async () => {
  const { fs, backend, operations } = filesystemFixture();
  const write = deferred<void>();
  backend.write = write.promise;
  const writing = fs.writeFile("/file", "first");
  await backend.writeEntered.promise;
  write.reject(new FilesystemError(51, "failed editor save"));
  // The service transports errors, so the page owns the decoded error, not the backend object.
  const failure = await writing.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FilesystemError);
  expect(failure).toHaveProperty("errno", 51);
  await expect(fs.flush()).rejects.toBe(failure);
  expect(operations).toEqual(["writeFile"]);
  await fs.writeFile("/file", "second");
  await fs.flush();
  expect(operations).toEqual(["writeFile", "writeFile", "flush"]);
  expect(decoder.decode(await fs.readFile("/file"))).toBe("second");
});

test("sandbox Restart cancels a pending install without launching its stale dev command", async () => {
  const page = await pageFixture({ "index.html": "page", "src/App.tsx": "app", "package.json": projectPackage });
  const sandbox = new page.Sandbox("");
  sandbox.start();
  sandbox.restart();
  expect(page.runs).toHaveLength(0);
  method<() => void>(sandbox, "terminalOpened")();
  await turn();
  expect(page.runs).toHaveLength(1);
  const markup = await page.renderSandbox(sandbox);
  expect(markup.match(/<button[^>]*id="restart"[^>]*>/)?.[0]).not.toContain("disabled");
  sandbox.restart();
  await turn();
  expect(page.runs).toHaveLength(2);
  expect(page.runs[0]!.kills).toEqual([9]);
  expect(page.runs[0]!.args).toEqual(["install"]);
  page.runs[0]!.done.resolve({ code: 0 });
  await turn();
  expect(page.runs).toHaveLength(2);
  page.runs[1]!.done.resolve({ code: 0 });
  await turn();
  expect(page.runs[2]!.args).toEqual(["run", "dev"]);
  expect(page.boundary.location.reloads).toBe(0);
  expect(sandbox.failure).toBeUndefined();
});

test("playground reports storage waiting, locks after takeover, and offers the saved-workspace reload", async () => {
  const page = await pageFixture();
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  await playground.start();
  expect(playground.ready).toBe(true);
  expect(playground.locked).toBe(false);
  page.fixture.fs.onStateChange?.({ status: "waiting" });
  expect(playground.status.text).toContain("Waiting for this workspace");
  page.fixture.fs.ownershipLost = true;
  page.fixture.fs.onOwnershipLost?.();
  expect(playground.failure).toBe("ownership");
  expect(playground.locked).toBe(true);
  expect(playground.status.text).toContain("Unsaved changes");
  const markup = await page.renderPlayground(playground);
  expect(markup).toContain('title="Open the latest saved workspace"');
  expect(markup.match(/<select[^>]*id="engine"[^>]*>/)?.[0]).toContain("disabled");
  expect(markup.match(/<button[^>]*id="run"[^>]*>/)?.[0]).not.toContain("disabled");
});

test("sandbox takeover locks workspace controls and Restart reloads the saved workspace", async () => {
  const page = await pageFixture();
  const sandbox = new page.Sandbox("");
  sandbox.start();
  page.fixture.fs.ownershipLost = true;
  page.fixture.fs.onOwnershipLost?.();
  expect(sandbox.failure).toBe("startup");
  expect(sandbox.status.text).toContain("Unsaved changes");
  const markup = await page.renderSandbox(sandbox);
  expect(markup).toContain('title="Open the latest saved workspace"');
  expect(markup.match(/<select[^>]*id="engine"[^>]*>/)?.[0]).toContain("disabled");
  expect(markup.match(/<button[^>]*id="reset"[^>]*>/)?.[0]).toContain("disabled");
  expect(markup.match(/<button[^>]*id="restart"[^>]*>/)?.[0]).not.toContain("disabled");
  sandbox.restart();
  expect(page.boundary.location.reloads).toBe(1);
});

test("sandbox stops on a failed install and only launches dev after a successful retry", async () => {
  const page = await pageFixture({ "package.json": projectPackage, "src/App.tsx": "app" });
  const sandbox = new page.Sandbox("");
  sandbox.start();
  method<() => void>(sandbox, "terminalOpened")();
  await turn();
  expect(page.runs[0]!.args).toEqual(["install"]);
  page.runs[0]!.done.resolve({ code: 1 });
  await turn();
  expect(page.runs).toHaveLength(1);
  expect(sandbox.serverState.state).toBe("down");
  expect(sandbox.serverState.text).toContain("install stopped (exit 1)");
  sandbox.restart();
  await turn();
  expect(page.runs[1]!.args).toEqual(["install"]);
  page.runs[1]!.done.resolve({ code: 0 });
  await turn();
  expect(page.runs[2]!.args).toEqual(["run", "dev"]);
});

test("playground passes the borrowed filesystem and truthful prompt options to the public session", async () => {
  const page = await pageFixture();
  const playground = new page.Playground("");
  method<() => void>(playground, "terminalOpened")();
  await playground.start();
  const prompt = page.promptCreates[0];
  const session = page.sessionCreates[0];
  expect(prompt).toBeDefined();
  expect(session).toBeDefined();
  expect(prompt?.filesystem).toBe(page.runtime.filesystem);
  expect(prompt?.versions).toEqual({});
  expect(prompt?.file).toBe(true);
  expect(prompt?.logger).toEqual(expect.any(Function));
  expect(Object.is(session?.runtime, page.runtime)).toBe(true);
  expect(session?.prompt).toBeDefined();
  expect(session?.env?.PS1).toBe("$ ");
  expect(session?.lineEditor).toEqual({ mode: "zsh" });
});

test("playground prompt-off arm skips the provider while keeping the session prompt empty", async () => {
  const page = await pageFixture();
  const playground = new page.Playground("?prompt=off");
  method<() => void>(playground, "terminalOpened")();
  await playground.start();
  expect(page.promptCreates).toEqual([]);
  expect(page.sessionCreates[0]?.prompt).toBeUndefined();
  expect(page.sessionCreates[0]?.env?.PS1).toBe("$ ");
});
