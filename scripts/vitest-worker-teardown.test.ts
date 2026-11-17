import { expect, test } from "bun:test";
import * as nativeEvents from "node:events";
import { eventTargetSource } from "./event-target-source";

const guest = eventTargetSource();

for (const [name, events, Controller] of [["native", nativeEvents, AbortController], ["guest", guest.events, guest.web.AbortController]] as const) {
  test(`${name}: Tinypool-style worker teardown resolves without a wrapper removal method`, async () => {
    const worker = new events.EventEmitter();
    const wrapper = {
      on: worker.on.bind(worker),
      once: worker.once.bind(worker),
    };
    const exited = events.once(wrapper, "exit");
    expect(() => worker.emit("exit", 0)).not.toThrow();
    expect(await exited).toEqual([0]);
    expect(worker.listenerCount("exit")).toBe(0);
    expect(worker.listenerCount("error")).toBe(1);
    worker.removeAllListeners();
  });

  test(`${name}: normal worker teardown still removes the error listener`, async () => {
    const worker = new events.EventEmitter();
    const exited = events.once(worker, "exit");
    worker.emit("exit", 0);
    expect(await exited).toEqual([0]);
    expect(worker.eventNames()).toEqual([]);
  });

  test(`${name}: worker failure rejects and removes the exit listener`, async () => {
    const worker = new events.EventEmitter();
    const failure = new Error("worker failed");
    const exited = events.once(worker, "exit");
    worker.emit("error", failure);
    await expect(exited).rejects.toBe(failure);
    expect(worker.eventNames()).toEqual([]);
  });

  test(`${name}: abort still removes both worker listeners`, async () => {
    const worker = new events.EventEmitter();
    const controller = new Controller();
    const exited = events.once(worker, "exit", { signal: controller.signal });
    controller.abort();
    await expect(exited).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.eventNames()).toEqual([]);
  });
}
