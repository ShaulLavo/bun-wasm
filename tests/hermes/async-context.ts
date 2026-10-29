import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();
const observations: string[] = [];
function check(label: string, expected: string | undefined): void {
  if (storage.getStore() !== expected) throw new Error(`${label}: ${storage.getStore()} != ${expected}`);
  observations.push(label);
}
function gate() {
  let release: () => void = () => { throw new Error("gate not initialized"); };
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function resumed(label: string): Promise<void> {
  await Promise.resolve();
  check(label, label);
  await null;
  check(`${label} twice`, label);
}
async function overlap(): Promise<void> {
  const waiting = gate();
  const one = storage.run("one", async () => { await waiting.promise; check("await one", "one"); });
  const two = storage.run("two", () => waiting.promise.then(() => check("then two", "two")));
  storage.run("resolver", waiting.release);
  check("resolver restored", undefined);
  await Promise.all([one, two]);
  check("overlap restored", undefined);
}
async function rejected(): Promise<void> {
  const failure = {};
  await storage.run("rejected", async () => {
    try { await Promise.reject(failure); }
    catch (error) {
      if (error !== failure) throw new Error("await rejection identity changed");
      check("await rejection", "rejected");
    }
  });
  check("rejection restored", undefined);
}
async function scheduled(): Promise<void> {
  const timer = storage.run("timer", () => new Promise<void>(resolve => setTimeout(() => {
    check("timer", "timer"); resolve();
  }, 1)));
  const microtask = storage.run("microtask", () => new Promise<void>(resolve => queueMicrotask(() => {
    check("queueMicrotask", "microtask"); resolve();
  })));
  const tick = storage.run("tick", () => new Promise<void>(resolve => process.nextTick(() => {
    check("nextTick", "tick"); resolve();
  })));
  await Promise.all([timer, microtask, tick]);
  check("scheduled restored", undefined);
}
async function nested(): Promise<void> {
  await storage.run("outer", async () => {
    await storage.run("inner", () => resumed("inner"));
    check("nested restored", "outer");
  });
  check("outer restored", undefined);
}

await Promise.all([storage.run("left", () => resumed("left")), storage.run("right", () => resumed("right"))]);
check("native await restored", undefined);
await overlap();
await rejected();
await scheduled();
await nested();
console.log("async context", observations.sort().join(","));
