import { expect, test } from "bun:test";
import { startFresh, unreadableWorkspace } from "../src/start-fresh";

const vfsError = (code: string) => Object.assign(new Error(code), { name: "VfsError", code, vfs: "indexeddb" });

test("a workspace Waffle cannot read, or one whose filesystem failed to open, offers Start fresh", () => {
  expect(unreadableWorkspace(vfsError("INVALID_VFS_FORMAT"), { status: "opening" })).toBe(true);
  expect(unreadableWorkspace(new Error("mkdirp failed", { cause: vfsError("INVALID_VFS_FORMAT") }), undefined)).toBe(true);
  expect(unreadableWorkspace(new Error("other"), { status: "failed", error: vfsError("INVALID_VFS_FORMAT") })).toBe(true);
  expect(unreadableWorkspace(new Error("open failed"), { status: "failed", error: new Error("IndexedDB refused") })).toBe(true);
});

test("a browser that lacks what the filesystem needs, or a filesystem that opened, offers nothing", () => {
  for (const code of ["UNSUPPORTED_VFS", "INVALID_VFS_SETTINGS", "UNSUPPORTED_VFS_CAPABILITY"])
    expect(unreadableWorkspace(vfsError(code), { status: "failed", error: vfsError(code) })).toBe(false);
  expect(unreadableWorkspace(new Error("engine missing"), { status: "ready" })).toBe(false);
  expect(unreadableWorkspace(new DOMException("full", "QuotaExceededError"), undefined)).toBe(false);
  const full = new Error("QuotaExceededError: filesystem startup failed");
  expect(unreadableWorkspace(full, { status: "failed", error: full })).toBe(false);
});

function recorder(answer: "deleted" | "missing" | "busy") {
  const calls: string[] = [];
  const remove = async (selection: { mode: "fast"; name: string }) => { calls.push(`delete ${selection.mode} ${selection.name}`); return answer; };
  return { calls, remove };
}

test("Start fresh disposes the failed runtime before deleting only its fast workspace", async () => {
  const { calls, remove } = recorder("deleted");
  expect(await startFresh(async () => { calls.push("dispose"); }, "bun-wasm-sandbox-vanilla", remove)).toBe("deleted");
  expect(calls).toEqual(["dispose", "delete fast bun-wasm-sandbox-vanilla"]);
});

test("Start fresh still deletes when disposal fails, and passes busy through", async () => {
  const { calls, remove } = recorder("busy");
  const warn = console.warn;
  console.warn = () => {};
  try {
    expect(await startFresh(async () => { calls.push("dispose"); throw new Error("worker gone"); }, "bun-wasm-workspace", remove)).toBe("busy");
  } finally { console.warn = warn; }
  expect(calls).toEqual(["dispose", "delete fast bun-wasm-workspace"]);
});
