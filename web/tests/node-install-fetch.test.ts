import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { createInterface } from "node:readline";

const FIXTURE = new URL("./fixtures/node-install-fetch.ts", import.meta.url).pathname;

for (const [mode, description] of [
  ["slots", "preserves head, body, error, memory and close slots before held EOF"],
  ["protocol", "bounds unacknowledged packets and progresses independent handles"],
  ["races", "does not miss replies across the shared wake poll sequence"],
  ["worker-exit", "reports a terminated worker and disposes it"],
  ["worker-failures", "reports worker startup, callback and exit failures without yielding the consumer"],
]) {
  test(`Node installer ${description}`, async () => {
    const lines = await fixture(mode!);
    expect(lines.some(line => line.startsWith(`passed:${mode}:v`))).toBe(true);
    if (mode === "slots") {
      expect(lines).toContain("slots-complete");
      const summary = lines.find(line => line.startsWith("slot-packets:"));
      expect(summary).toBeDefined();
      console.info(summary);
    }
    if (mode === "races") expect(lines.filter(line => line.startsWith("race-passed:"))).toHaveLength(5);
    if (mode === "worker-exit") expect(lines).toContain("worker-exit-reported");
    if (mode === "worker-failures") expect(lines.filter(line => line.startsWith("worker-failure-sync:"))).toHaveLength(3);
    if (mode !== "protocol") return;
    const summary = lines.find(line => line.startsWith("protocol:"));
    expect(summary).toBeDefined();
    const result = JSON.parse(summary!.slice("protocol:".length));
    expect(result.total).toBe(190000);
    expect(result.maximum).toBeLessThanOrEqual(65536);
    expect(result.unacknowledgedPackets).toBe(1);
    expect(result.acknowledgments).toBeGreaterThan(1);
    console.info(summary);
  }, 15000);
}

async function fixture(mode: string): Promise<string[]> {
  const responses = new Map<string, ServerResponse>();
  const releasedRaces = new Set<string>();
  const lines: string[] = [], errors: string[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let exit: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  let output: ReturnType<typeof createInterface> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false, orderingError = "";
  const server = createServer((request, response) => {
    const path = request.url!;
    responses.set(path, response);
    if (path === "/disconnect") { request.socket.destroy(); return; }
    if (path.startsWith("/race-")) {
      if (releasedRaces.has(path)) response.writeHead(204).end();
      return;
    }
    if (path.startsWith("/pending")) {
      if (path === "/pending") child?.send?.("pending-accepted");
      return;
    }
    if (path === "/redirect") { response.writeHead(302, { location: "/missing" }); response.end(); return; }
    if (path === "/empty") { response.writeHead(204); response.end(); return; }
    if (path === "/missing") { response.writeHead(404, "Missing"); response.end("missing"); return; }
    if (path === "/large") { response.end(Uint8Array.from({ length: 190000 }, (_, i) => (i * 17 + 3) % 251)); return; }
    if (path === "/body-error") { response.writeHead(200, { "content-length": "100" }); response.write("abcde"); return; }
    if (path === "/progress") {
      response.writeHead(202, "Streaming", { "x-audit": "003" }); response.flushHeaders(); response.write("first"); return;
    }
    response.writeHead(200); response.flushHeaders();
    response.write(path === "/held-large" ? new Uint8Array(90000) : path === "/grow" ? "grown" : "abc");
  });
  const onLine = (line: string) => {
    lines.push(line);
    const progress = responses.get("/progress");
    if (line === "head-before-eof" || line.startsWith("piece:")) {
      if (!progress || progress.writableEnded) orderingError = `EOF released before ${line}`;
    }
    if (line === "piece:first") progress?.write("second");
    if (line === "piece:second") progress?.write("third");
    if (line === "piece:third") progress?.end("last");
    if (line === "break-body") responses.get("/body-error")?.destroy();
    if (!line.startsWith("race-release:")) return;
    const path = `/race-${line.slice("race-release:".length)}`;
    releasedRaces.add(path);
    responses.get(path)?.writeHead(204).end();
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing ephemeral server port");
    child = spawn("node", [FIXTURE, mode, `http://127.0.0.1:${address.port}`], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    // Install exit/error listeners and failure teardown before the first child await.
    exit = new Promise((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve([code, signal]));
    });
    output = createInterface({ input: child.stdout! });
    output.on("line", onLine);
    child.stderr!.on("data", bytes => errors.push(String(bytes)));
    timer = setTimeout(() => { timedOut = true; child?.kill("SIGKILL"); }, 12000);
    const [code, signal] = await exit;
    if (timedOut || code !== 0 || signal) throw new Error(`Node ${mode} failed (${code ?? signal}, timeout=${timedOut}): ${lines.join(" | ")}\n${errors.join("")}`);
    expect(orderingError).toBe(""); expect(errors.join("")).toBe("");
    if (mode === "slots") expect(lines).toContain("head-before-eof");
    return lines;
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit?.catch(() => undefined);
    output?.close();
    for (const response of responses.values()) response.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
