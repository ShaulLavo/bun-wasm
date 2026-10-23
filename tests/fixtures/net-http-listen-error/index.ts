import { expect, jest } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";

async function check(fake: boolean) {
  const holder = createServer();
  const contender = createServer();
  const events: string[] = [];
  contender.on("listening", () => events.push("listening"));
  contender.on("error", () => events.push("error"));
  try {
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const address = holder.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    if (fake) jest.useFakeTimers({ now: 0 });
    const failed = new Promise<Error & { code?: string }>((resolve, reject) => {
      contender.once("error", resolve);
      contender.once("listening", () => reject(new Error("Occupied listener must not announce listening")));
    });
    contender.listen(address.port, "127.0.0.1");
    const error = await failed;
    expect(error.code).toBe("EADDRINUSE");
    expect(contender.listening).toBe(false);
    expect(events).toEqual(["error"]);
    if (fake) expect(jest.getTimerCount()).toBe(0);
    console.log("occupied port", fake ? "fake" : "real", "ok");
  } finally {
    jest.useRealTimers();
    contender.close();
    await new Promise<void>(resolve => holder.close(() => resolve()));
  }
}

await check(false);
await check(true);

const stopped = createServer();
let announced = false;
stopped.on("listening", () => { announced = true; });
const closed = once(stopped, "close");
stopped.listen(0, "127.0.0.1");
stopped.close();
await closed;
expect(announced).toBe(false);
console.log("closed startup stays closed");

const reused = createServer();
await new Promise<void>((resolve, reject) => {
  reused.on("error", reject);
  reused.listen(0, "127.0.0.1", () => {
    reused.close();
    reused.listen(0, "127.0.0.1", () => reused.close(error => error ? reject(error) : resolve()));
  });
});
console.log("callback relisten exits cleanly");
