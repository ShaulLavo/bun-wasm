import { expect, test } from "bun:test";
import { allocateSafariDriverPort, assertSafariDriverOwnership, ownSafariDriver, parseSafariProcessTable, stopSafariDriver,
  type SafariDriverIdentity, type SafariInspection, type SafariProcessIdentity } from "./engine-interruption-safari";

function driver(): SafariDriverIdentity { return { pid: 41, exitCode: null, signalCode: null }; }
function row(pid = 41, ppid = 1, session = "7", started = 1_000): SafariProcessIdentity { return { pid, ppid, session, started }; }
function inspect(listeners: number[], processes = [row()]): SafariInspection {
  return { listeners: async () => listeners, processes: async () => processes };
}
function scope() { return ownSafariDriver(driver(), 1_000); }

test("Safari parses C-locale macOS process rows with opaque hexadecimal or zero session IDs", () => {
  const started = "Sat Oct 17 09:24:03 2026";
  expect(parseSafariProcessTable(` 27120 1 10000abc ${started}\n 27124 27120 10000abc ${started}\n 99 1 0 ${started}\n`)).toEqual([
    row(27120, 1, "10000abc", Date.parse(started)), row(27124, 27120, "10000abc", Date.parse(started)), row(99, 1, "0", Date.parse(started)),
  ]);
  expect(() => parseSafariProcessTable("27120 1 abc invalid birth")).toThrow("start time");
  expect(() => parseSafariProcessTable("not a process row")).toThrow("process identity");
});
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
test("Safari accepts the task-created live driver as listener and rejects unrelated listeners", async () => {
  const owned = scope();
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([41]))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42]))).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([]))).rejects.toThrow("not owned");
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([41, 42]))).rejects.toThrow("not owned");
});
test("Safari accepts a same-session listener descended from its driver, including deeper descendants", async () => {
  const processes = [row(43, 42), row(42, 41), row()];
  await expect(assertSafariDriverOwnership(scope(), 43186, inspect([43], processes))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(scope(), 43186, inspect([41, 42, 43], processes))).resolves.toBeUndefined();
});
for (const [name, processes] of [
  ["same-session sibling", [row(), row(42)]],
  ["different-session child", [row(), row(42, 41, "8")]],
  ["child predating spawn", [row(), row(42, 41, "7", 0)]],
  ["child predating its parent", [row(41, 1, "7", 3_000), row(42, 41, "7", 2_000)]],
  ["missing ancestor", [row(), row(42, 44)]],
  ["parent cycle", [row(), row(42, 43), row(43, 42)]],
] satisfies [string, SafariProcessIdentity[]][]) {
  test(`Safari rejects ${name} as a listener`, async () => {
    await expect(assertSafariDriverOwnership(scope(), 43186, inspect([42], processes))).rejects.toThrow("not owned");
  });
}
test("Safari rejects a root that predates spawn or changes birth/session identity", async () => {
  await expect(assertSafariDriverOwnership(scope(), 43186, inspect([41], [row(41, 1, "7", 0)]))).rejects.toThrow("identity changed");
  const owned = scope();
  await assertSafariDriverOwnership(owned, 43186, inspect([41]));
  for (const replacement of [row(41, 1, "7", 2_000), row(41, 1, "8")]) {
    await expect(assertSafariDriverOwnership(owned, 43186, inspect([41], [replacement]))).rejects.toThrow("identity changed");
  }
});
test("Safari allows the spawn second's coarse ps timestamp but not an earlier second", async () => {
  const owned = ownSafariDriver(driver(), 1_999);
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41)]))).resolves.toBeUndefined();
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41, "7", 0)]))).rejects.toThrow("not owned");
});
test("Safari rejects an absent root and never adopts a previously verified orphan for requests", async () => {
  const owned = scope();
  await assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41)]));
  await expect(assertSafariDriverOwnership(owned, 43186, inspect([42], [row(42, 1)]))).rejects.toThrow("not owned");
});
test("Safari never adopts a winning driver's session after its own driver exits", async () => {
  const owned = scope(); owned.driver.exitCode = 1;
  let inspected = false;
  await expect(assertSafariDriverOwnership(owned, 43186, { ...inspect([]), listeners: async () => { inspected = true; return [42]; } })).rejects.toThrow("exited");
  expect(inspected).toBe(false);
});
test("Safari checks child health again after asynchronous listener and process inspection", async () => {
  const owned = scope();
  await expect(assertSafariDriverOwnership(owned, 43186, { ...inspect([41]), processes: async () => {
    owned.driver.signalCode = "SIGTERM"; return [row()];
  } })).rejects.toThrow("exited");
});
test("Safari teardown remembers a verified child after reparenting and stops it before the parent", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  const inspection: SafariInspection = { processes: async () => processes, listeners: async () => processes.some(row => row.pid === 42) ? [42] : [] };
  await assertSafariDriverOwnership(owned, 43186, inspection);
  processes = [row(), row(42, 1)];
  await stopSafariDriver(owned, 43186, inspection, pid => { signalled.push(pid); processes = processes.filter(row => row.pid !== pid); });
  expect(signalled).toEqual([42, 41]);
});
test("Safari teardown stops a verified orphan after the root exits", async () => {
  const owned = scope(), signalled: number[] = [];
  await assertSafariDriverOwnership(owned, 43186, inspect([42], [row(), row(42, 41)]));
  owned.driver.exitCode = 1;
  let processes = [row(42, 1)];
  await stopSafariDriver(owned, 43186, { processes: async () => processes, listeners: async () => [] }, pid => {
    signalled.push(pid); processes = [];
  });
  expect(signalled).toEqual([42]);
});
test("Safari teardown tolerates ESRCH but does not claim success on inspection or other signal errors", async () => {
  let processes = [row()];
  const inspection = { processes: async () => processes, listeners: async () => [] };
  await expect(stopSafariDriver(scope(), 43186, inspection, () => {
    processes = []; throw Object.assign(new Error("gone"), { code: "ESRCH" });
  })).resolves.toBeUndefined();
  await expect(stopSafariDriver(scope(), 43186, inspect([], [row()]), () => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  })).rejects.toThrow("denied");
  await expect(stopSafariDriver(scope(), 43186, { ...inspection, processes: async () => { throw new Error("ps failed"); } })).rejects.toThrow("ps failed");
});
test("Safari teardown shares one bounded inspection deadline instead of leaving an inspection race running", async () => {
  const before = Date.now(), deadlines: (number | undefined)[] = [];
  let processes = [row()];
  await stopSafariDriver(scope(), 43186, { processes: async deadline => { deadlines.push(deadline); return processes; },
    listeners: async (_port, deadline) => { deadlines.push(deadline); return []; } }, () => { processes = []; });
  expect(deadlines).toHaveLength(3);
  expect(deadlines.every(deadline => deadline === deadlines[0])).toBe(true);
  expect(deadlines[0]).toBeGreaterThan(before);
  expect(deadlines[0]! - before).toBeLessThanOrEqual(12_000);
});
test("Safari teardown discovers a non-listening child forked during shutdown", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row()];
  let inspected = 0;
  await stopSafariDriver(owned, 43186, { processes: async () => {
    inspected++;
    if (inspected === 2) processes.push(row(42, 41));
    return processes;
  }, listeners: async () => [] }, pid => {
    signalled.push(pid);
    if (pid === 42 || signalled.filter(value => value === 41).length > 1) processes = processes.filter(row => row.pid !== pid);
  });
  expect(signalled).toContain(42);
  expect(processes).toEqual([]);
});
test("Safari teardown discovers children even if startup fails before the first ownership check", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  await stopSafariDriver(owned, 43186, { processes: async () => processes, listeners: async () => [] }, pid => {
    signalled.push(pid); processes = processes.filter(row => row.pid !== pid);
  });
  expect(signalled).toEqual([42, 41]);
});
test("Safari teardown never signals a reused child PID or unrelated listener, and reports an occupied port", async () => {
  const owned = scope(), signalled: number[] = [];
  let processes = [row(), row(42, 41)];
  const inspection: SafariInspection = { processes: async () => processes, listeners: async () => [42] };
  await assertSafariDriverOwnership(owned, 43186, inspection);
  processes = [row(), row(42, 1, "7", 2_000), row(99)];
  await expect(stopSafariDriver(owned, 43186, inspection, pid => {
    signalled.push(pid); processes = processes.filter(row => row.pid !== pid);
  })).rejects.toThrow("listeners=42");
  expect(signalled).toEqual([41]);
  expect(processes.map(row => row.pid)).toEqual([42, 99]);
});
test("Safari teardown escalates an unresponsive owned driver without signalling unrelated processes", async () => {
  const signals: string[] = [];
  let processes = [row(), row(99)];
  await stopSafariDriver(scope(), 43186, { processes: async () => processes, listeners: async () => [] }, (pid, signal) => {
    signals.push(`${pid}:${signal}`);
    if (signal === "SIGKILL") processes = processes.filter(row => row.pid !== pid);
  });
  expect(signals).toEqual(["41:SIGTERM", "41:SIGKILL"]);
  expect(processes).toEqual([row(99)]);
});

test("Safari owns a real parent-spawned child listener and tears down both without a browser", async () => {
  // No pre-existing resources are modified. This fixture owns one parent, its
  // child listener and one ephemeral port; fallback teardown is installed first.
  let parent: ReturnType<typeof Bun.spawn> | undefined;
  let childPid: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function kill(pid: number | undefined): void {
    if (pid === undefined) return;
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }
  try {
    const spawnedAfter = Date.now();
    const spawned = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/safari-driver-listener.ts`], { stdout: "pipe", stderr: "inherit" });
    parent = spawned;
    deadline = setTimeout(() => { kill(childPid); if (parent?.exitCode === null) parent.kill("SIGKILL"); }, 7_000);
    const reader = spawned.stdout.getReader();
    const decoder = new TextDecoder();
    let line = "";
    try {
      while (!line.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("listener fixture exited before publishing its PID and port");
        line += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    const published: unknown = JSON.parse(line.trim());
    if (typeof published !== "object" || published === null || !("pid" in published) || !("port" in published)
      || typeof published.pid !== "number" || typeof published.port !== "number") throw new Error("invalid listener fixture identity");
    childPid = published.pid;
    const port = published.port;
    expect(childPid).not.toBe(parent.pid);
    const owned = ownSafariDriver(parent, spawnedAfter);
    await assertSafariDriverOwnership(owned, port);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("owned child");
    await stopSafariDriver(owned, port);
    await parent.exited;
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
  } finally {
    clearTimeout(deadline);
    kill(childPid);
    if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await parent?.exited;
  }
}, 10_000);
