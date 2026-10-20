import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { startBackends } from "./backends";
import { closeServer, lifetime, listen } from "./lifetime";
import { ports } from "./ports.server";

test("partial startup rolls back only acquired listeners and close repeats", async () => {
  const owner = createServer((_req, res) => res.end("owner"));
  await listen(owner, ports.koa);
  const scope = lifetime();
  try {
    await expect(startBackends(scope)).rejects.toThrow();
    await scope.close();
    await scope.close();
    expect(await (await fetch(`http://127.0.0.1:${ports.koa}`)).text()).toBe("owner");
    const probe = createServer();
    await listen(probe, ports.express);
    await closeServer(probe);
  } finally {
    await scope.close();
    await closeServer(owner);
  }
});

test("all five listeners close, including Bun servers", async () => {
  const scope = lifetime();
  try { await startBackends(scope); } finally { await scope.close(); }
  await scope.close();
  for (const port of Object.values(ports)) {
    const probe = createServer();
    await listen(probe, port);
    await closeServer(probe);
  }
});
