import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withNativeDriver } from "../native";
import { createSafariTransport } from "../safari-transport";
import { ownershipReceipt, type SafariOwnershipEvent } from "../safari-ownership";
import { scoped } from "../scoped-transport";
import { Scope } from "../scope";

async function closeFixture(transport: Awaited<ReturnType<typeof createSafariTransport>> | undefined, server: ReturnType<typeof Bun.serve>): Promise<void> {
  try { await transport?.close(true); }
  finally { await server.stop(true); }
}

export async function runOwnershipSmoke(output: string, commit: string): Promise<void> {
  assert.match(commit, /^[a-f0-9]{40}$/);
  await mkdir(join(output, "logs"), { recursive: true });
  const identity = { run: crypto.randomUUID(), source: { commit, dirty: false }, cell: "fixture/safari/browser", attempt: 1 };
  const sink = ownershipReceipt(output, identity);
  const events: SafariOwnershipEvent[] = [];
  await withNativeDriver(async (endpoint, signal) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>Ownership fixture</title><p>Own fixture</p>", { headers: { "content-type": "text/html" } }) });
    let transport: Awaited<ReturnType<typeof createSafariTransport>> | undefined;
    const scope = Scope.open(15_000, signal);
    try {
      transport = await createSafariTransport({ endpoint, browser: "safari", timeoutMs: 10_000, cleanupTimeoutMs: 5000,
        ownershipSink: event => { events.push(event); return sink(event); } });
      const page = scoped(transport, scope);
      await page.navigate(server.url.href);
      await page.openPreview(new URL("preview", server.url).href);
      assert.ok(events.some(event => event.sessionId && event.hostHandle));
      assert.ok(events.some(event => event.operation.kind === "frame-reference" && event.outcome.state === "acknowledged" && event.outcome.observation.kind === "element"));
      assert.ok(!events.some(event => event.operation.kind === "session-delete"));
      const files = await readdir(join(output, "logs"));
      assert.equal(files.length, 1);
      const retained = await readFile(join(output, "logs", files[0]!), "utf8");
      assert.equal(retained.trim().split("\n").length, events.length);
      await writeFile(join(output, "before-teardown.json"), JSON.stringify({ ...identity, events }, null, 2));
      await page.closePreview();
    } finally {
      scope.close();
      await closeFixture(transport, server);
    }
  }, { desktopSafari: true, cleanupFile: join(output, "native-cleanup.json") });
  assert.ok(events.some(event => event.operation.kind === "frame-remove" && event.outcome.state === "acknowledged"));
  assert.ok(events.some(event => event.operation.kind === "session-delete" && event.outcome.state === "acknowledged"));
  await writeFile(join(output, "smoke.json"), JSON.stringify({ ...identity, events: events.length, beforeTeardownRetained: true, frameRemovalAcknowledged: true, sessionDeletionAcknowledged: true, physicalWindowAbsence: "unknown" }, null, 2));
}

if (import.meta.main) {
  const output = process.argv[2], commit = process.argv[3];
  if (!output || !commit) throw new Error("Usage: safari-ownership-smoke.ts OUTPUT SOURCE_COMMIT");
  await runOwnershipSmoke(resolve(output), commit);
}
