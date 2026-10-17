import { expect, test } from "bun:test";
import { allocateSafariDriverPort, assertSafariDriverOwnership, type SafariDriverIdentity } from "./engine-interruption-safari";

function driver(): SafariDriverIdentity { return { pid: 41, exitCode: null, signalCode: null }; }
test("Safari defaults to a privately allocated ephemeral port", async () => {
  const port = await allocateSafariDriverPort();
  expect(Number.isInteger(port) && port > 1023 && port < 65536).toBe(true);
});
test("Safari refuses an occupied explicit port without touching the listener", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owner") });
  try {
    await expect(allocateSafariDriverPort(server.port!)).rejects.toThrow();
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("owner");
  } finally { server.stop(true); }
});
test("Safari accepts only the task-created live driver as listener", async () => {
  const owned = driver();
  await expect(assertSafariDriverOwnership(owned, 43186, async () => [41])).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(owned, 43186, async () => [42])).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(owned, 43186, async () => [])).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(owned, 43186, async () => [41, 42])).rejects.toThrow("not owned");
});
test("Safari never adopts a winning driver's session after its own driver exits", async () => {
  const owned = driver(); owned.exitCode = 1;
  let inspected = false;
  await expect(assertSafariDriverOwnership(owned, 43186, async () => { inspected = true; return [42]; })).rejects.toThrow("exited");
  expect(inspected).toBe(false);
});
test("Safari checks child health again after asynchronous listener inspection", async () => {
  const owned = driver();
  await expect(assertSafariDriverOwnership(owned, 43186, async () => { owned.signalCode = "SIGTERM"; return [41]; })).rejects.toThrow("exited");
});
