import { afterEach, expect, spyOn, test } from "bun:test";
import { models } from "./ui-model-helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** A playground whose stored workspace this Waffle cannot read. */
async function unreadablePlayground(search: string, answer: "deleted" | "busy") {
  const page = await models();
  cleanups.push(page.cleanup);
  const error = Object.assign(new Error("Incompatible IndexedDB filesystem format identity"), { name: "VfsError", code: "INVALID_VFS_FORMAT", vfs: "indexeddb" });
  Object.assign(page.fixture.fs, { state: { status: "failed", error }, mkdirp: async () => { throw error; } });
  page.boundary.deleteResult = answer;
  const playground = new page.Playground(search);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try { await playground.start(); } finally { errors.mockRestore(); }
  page.runtime.dispose = async () => { page.storageEvents.push("dispose"); };
  return { page, playground };
}

test("a playground workspace that cannot be opened offers Start fresh, which deletes only it and reloads", async () => {
  const { page, playground } = await unreadablePlayground("?template=vite-react", "deleted");
  expect(playground.failure).toBe("startup");
  expect(playground.unreadable).toBe(true);
  expect(playground.status.text).toContain("cannot be opened");
  expect(await page.renderPlayground(playground)).toContain(">Start fresh</button>");
  await playground.startFresh();
  expect(page.storageEvents.slice(page.storageEvents.indexOf("dispose"))).toEqual(["dispose", "delete bun-wasm-workspace-vite-react"]);
  expect(page.boundary.location.reloads).toBe(1);
});

test("playground Start fresh on a workspace another tab holds deletes nothing and asks to close that tab", async () => {
  const { page, playground } = await unreadablePlayground("", "busy");
  await playground.startFresh();
  expect(page.storageEvents).toContain("delete bun-wasm-workspace");
  expect(page.boundary.location.reloads).toBe(0);
  expect(playground.status.text).toContain("open in another tab");
  expect(playground.startingFresh).toBe(false);
});

test("a startup failure with a readable workspace offers no Start fresh", async () => {
  const page = await models();
  cleanups.push(page.cleanup);
  const playground = new page.Playground("?mode=memory");
  Object.assign(page.fixture.fs, { mkdirp: async () => { throw Object.assign(new Error("format"), { name: "VfsError", code: "INVALID_VFS_FORMAT" }); } });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try { await playground.start(); } finally { errors.mockRestore(); }
  expect(playground.failure).toBe("startup");
  expect(playground.unreadable).toBe(false);
  expect(await page.renderPlayground(playground)).not.toContain("Start fresh");
});
