import { expect, test } from "bun:test";
import { handledSignalGuest, idleSignalGuest } from "./engine-interruption-guests";

// Each reference run owns one native Node process and its pipes, with no files or
// listeners. Arm bounded teardown before spawning; never leave a looping handler.
async function nodeReference(nested: boolean, source = handledSignalGuest(nested)) {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const deadline = setTimeout(() => child?.kill("SIGKILL"), 5_000);
  try {
    child = Bun.spawn(["node", "-e", source], { stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    let stderr = "", sentInterrupt = false, sentTerminate = false;
    for await (const bytes of child.stderr as ReadableStream<Uint8Array>) {
      stderr += new TextDecoder().decode(bytes);
      if (!sentInterrupt && stderr.includes("ready\n")) { sentInterrupt = true; child.kill("SIGINT"); }
      if (nested && !sentTerminate && stderr.includes("handler-ready\n")) { sentTerminate = true; child.kill("SIGTERM"); }
    }
    return { stdout: await stdout, stderr, status: await child.exited, signal: child.signalCode };
  } finally {
    clearTimeout(deadline);
    if (child) { child.kill("SIGKILL"); await child.exited; }
  }
}

test("Node queues handled SIGINT until finite synchronous CPU work yields", async () => {
  const result = await nodeReference(false);
  expect(result.status).toBe(23);
  expect(result.stderr).toBe("ready\nloop-finished\nhandled\n");
  expect(result.stdout).toBe("continued 1 true\n");
}, 10_000);

test("Node enters a queued handler after yielding and default SIGTERM kills its CPU loop", async () => {
  const result = await nodeReference(true);
  expect(result.signal).toBe("SIGTERM");
  expect(result.stderr).toBe("ready\nloop-finished\nhandler-ready\n");
  expect(result.stdout).toBe("");
}, 10_000);
test("Node wakes an interval-kept idle loop for handled SIGINT and retains ordinary23", async () => {
  const result = await nodeReference(false, idleSignalGuest);
  expect(result.status).toBe(23);
  expect(result.stderr).toBe("ready\nidle-handled\n");
  expect(result.stdout).toBe("");
}, 10_000);
