import { expect, jest } from "bun:test";
import { readFile } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import { gzip } from "node:zlib";

function read() {
  return new Promise<void>((resolve, reject) => {
    readFile(import.meta.path, (error) => error ? reject(error) : resolve());
  });
}

const channel = new MessageChannel();
function message(value: string) {
  const received = new Promise<string>(resolve => channel.port1.once("message", resolve));
  channel.port2.postMessage(value);
  return received;
}

try {
  jest.useFakeTimers({ now: 0 });
  await read();
  expect(await message("fake")).toBe("fake");
  await new Promise<void>((resolve, reject) => randomBytes(8, error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => gzip("timer", error => error ? reject(error) : resolve()));
  expect(jest.getTimerCount()).toBe(0);
  expect(Date.now()).toBe(0);

  const pendingRead = read();
  const pendingMessage = message("pending at restore");
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
  await pendingRead;
  expect(await pendingMessage).toBe("pending at restore");
  expect(await message("after restore")).toBe("after restore");

  for (const restore of [false, true]) {
    jest.useFakeTimers({ now: 0 });
    const child = Bun.spawn([process.execPath, "-e", "Bun.sleepSync(3000)"], {
      stdout: "ignore", stderr: "ignore", timeout: 25, killSignal: "SIGKILL",
    });
    try {
      expect(jest.getTimerCount()).toBe(0);
      if (restore) jest.useRealTimers();
      expect(await child.exited).toBe(137);
      expect(child.exitedDueToTimeout).toBe(true);
      if (!restore) expect(Date.now()).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }
} finally {
  jest.useRealTimers();
  channel.port1.close();
  channel.port2.close();
}
console.log("runtime callbacks keep real timers ok");
