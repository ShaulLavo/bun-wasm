import { expect, test } from "bun:test";
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
