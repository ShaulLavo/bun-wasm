import { expect, test } from "bun:test";
import { startFresh, unreadableWorkspace } from "../src/start-fresh";

const vfsError = (code: string) => Object.assign(new Error(code), { name: "VfsError", code, vfs: "indexeddb" });

test("only a stored format Waffle cannot read offers Start fresh", () => {
  expect(unreadableWorkspace(vfsError("INVALID_VFS_FORMAT"), { status: "opening" })).toBe(true);
  expect(unreadableWorkspace(new Error("mkdirp failed", { cause: vfsError("INVALID_VFS_FORMAT") }), undefined)).toBe(true);
  expect(unreadableWorkspace(new Error("other"), { status: "failed", error: vfsError("INVALID_VFS_FORMAT") })).toBe(true);
});

test("failures a retry can fix keep the workspace and offer no Start fresh", () => {
  // A filesystem worker that did not load (a blocked fetch, a deploy, offline), a lost IndexedDB
  // connection, full storage, missing browser support: the same workspace opens on a retry.
  for (const error of [new Error("Failed to load worker script fs-worker.js"), new Error("Connection to Indexed Database server lost. Refresh the page to try again"),
    new DOMException("full", "QuotaExceededError"), vfsError("UNSUPPORTED_VFS"), new RangeError("Out of memory")])
    expect(unreadableWorkspace(error, { status: "failed", error })).toBe(false);
  expect(unreadableWorkspace(new Error("engine missing"), { status: "ready" })).toBe(false);
});

function storage(open: () => Promise<unknown>, answer: "deleted" | "missing" | "busy" = "deleted") {
  const calls: string[] = [];
  return {
    calls,
    waffle: {
      open: async (selection: { mode: "fast"; name: string }) => { calls.push(`open ${selection.mode} ${selection.name}`); return open() as never; },
      remove: async (selection: { mode: "fast"; name: string }) => { calls.push(`delete ${selection.mode} ${selection.name}`); return answer; },
    },
  };
}

test("Start fresh disposes the failed runtime, then deletes the workspace only while it still cannot be opened", async () => {
  const { calls, waffle } = storage(async () => { throw vfsError("INVALID_VFS_FORMAT"); });
  expect(await startFresh(async () => { calls.push("dispose"); }, "bun-wasm-sandbox-vanilla", waffle)).toBe("deleted");
  expect(calls).toEqual(["dispose", "open fast bun-wasm-sandbox-vanilla", "delete fast bun-wasm-sandbox-vanilla"]);
});

test("a workspace another tab recovered in the meantime is kept", async () => {
  const closed: string[] = [];
  const { calls, waffle } = storage(async () => ({ close: async () => { closed.push("closed"); } }));
  expect(await startFresh(undefined, "bun-wasm-workspace", waffle)).toBe("readable");
  expect(calls).toEqual(["open fast bun-wasm-workspace"]);
  expect(closed).toEqual(["closed"]);
  const missing = storage(async () => "missing");
  expect(await startFresh(undefined, "bun-wasm-workspace", missing.waffle)).toBe("missing");
  expect(missing.calls).toEqual(["open fast bun-wasm-workspace"]);
});

test("Start fresh deletes nothing while another tab holds the workspace, or when the check itself fails", async () => {
  const held = storage(async () => "busy");
  expect(await startFresh(undefined, "bun-wasm-workspace", held.waffle)).toBe("busy");
  expect(held.calls).toEqual(["open fast bun-wasm-workspace"]);
  const failing = storage(async () => { throw new Error("Connection to Indexed Database server lost"); });
  await expect(startFresh(undefined, "bun-wasm-workspace", failing.waffle)).rejects.toThrow("Connection to Indexed Database server lost");
  expect(failing.calls).toEqual(["open fast bun-wasm-workspace"]);
});

test("Start fresh still checks and deletes when disposal fails, and passes a busy delete through", async () => {
  const { calls, waffle } = storage(async () => { throw vfsError("INVALID_VFS_FORMAT"); }, "busy");
  const warn = console.warn;
  console.warn = () => {};
  try {
    expect(await startFresh(async () => { calls.push("dispose"); throw new Error("worker gone"); }, "bun-wasm-workspace", waffle)).toBe("busy");
  } finally { console.warn = warn; }
  expect(calls).toEqual(["dispose", "open fast bun-wasm-workspace", "delete fast bun-wasm-workspace"]);
});
