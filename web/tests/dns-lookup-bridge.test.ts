import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createLookupClient, installLookupServer } from "../src/net/lookup";

test("DNS bridge delegates to the runtime network without socket traffic", async () => {
  const channel = new MessageChannel();
  let calls = 0;
  const dispose = installLookupServer(channel.port1, {
    lookup(hostname, options) {
      calls++;
      expect(hostname).toBe("localhost");
      expect(options).toEqual({ family: 0, hints: 0 });
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  const lookup = createLookupClient(channel.port2);
  expect(await lookup("localhost", 0, 0)).toEqual([{ address: "127.0.0.1", family: 4 }]);
  expect(calls).toBe(1);
  dispose();
});

test("DNS bridge preserves Waffle lookup errors", async () => {
  const channel = new MessageChannel();
  installLookupServer(channel.port1, {
    lookup() {
      throw Object.assign(new Error("No IPv4 address found"), { code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "localhost" });
    },
  });
  const lookup = createLookupClient(channel.port2);
  await expect(lookup("localhost", 4, 0)).rejects.toMatchObject({ code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "localhost" });
  channel.port1.close();
  channel.port2.close();
});

test("DNS bridge works through a browser worker channel name", async () => {
  const name = `bun-wasm-dns-test-${crypto.randomUUID()}`;
  const server = new BroadcastChannel(name);
  const client = new BroadcastChannel(name);
  const dispose = installLookupServer(server, {
    lookup(hostname, options) {
      expect(hostname).toBe("localhost");
      expect(options).toEqual({ family: 0, hints: 0 });
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  const lookup = createLookupClient(client);
  try {
    expect(await lookup("localhost", 0, 0)).toEqual([{ address: "127.0.0.1", family: 4 }]);
  } finally {
    lookup.close();
    dispose();
  }
});

test("prepared Waffle exports keep the native worker lookup control green", () => {
  const workerUrl = new URL("../node_modules/waffle/dist/browser/fs-worker.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createRuntime, RuntimeNetworkLookupError } from "waffle";
    const runtime = createRuntime({
      filesystem: { mode: "memory", workerURL: new URL(${JSON.stringify(workerUrl)}) },
      processHost() { throw Error("lookup control must not activate processes"); },
    });
    const network = await runtime.network();
    try {
      assert.deepEqual(network.lookup("localhost", { family: 0, hints: 0 }), [{ address: "127.0.0.1", family: 4 }]);
      assert.throws(() => network.lookup("localhost", { family: 6 }), (error) => error instanceof RuntimeNetworkLookupError && error.code === "ENOTFOUND");
    } finally {
      await runtime.dispose();
    }
    console.log("prepared Waffle lookup control passed");
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("prepared Waffle lookup control passed");
});
