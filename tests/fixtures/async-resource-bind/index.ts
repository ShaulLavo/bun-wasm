import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

// AsyncResource.bind, its static form and runInAsyncScope run in the context the resource was
// created in, as native Bun does. Expected output is native Bun 1.4.4's.
const outer = new AsyncLocalStorage<string>();
const inner = new AsyncLocalStorage<string>();
const stores = () => `${outer.getStore()}/${inner.getStore()}`;

const [resource, staticBound, staticWithThis] = outer.run("o1", () => inner.run("i1", () => [
  new AsyncResource("fixture"),
  AsyncResource.bind(function staticTarget(this: unknown, a: number, b: number) {
    return `${stores()} this=${String(this)} args=${a},${b}`;
  }),
  AsyncResource.bind(function (this: unknown) {
    return `${stores()} this=${String(this)}`;
  }, "typed", "receiver"),
]));

const instanceBound = resource.bind(function (this: unknown, value: string) {
  return `${stores()} this=${String(this)} arg=${value}`;
});
const instanceWithThis = resource.bind(function (this: unknown) {
  return `${stores()} this=${String(this)}`;
}, "fixed");

console.log("instance bind", outer.run("o2", () => instanceBound.call("caller", "x")));
console.log("instance bind thisArg", outer.run("o2", () => instanceWithThis.call("ignored")));
console.log("static bind", inner.run("i2", () => staticBound.call("caller", 1, 2)));
console.log("static bind thisArg", staticWithThis.call("ignored"));
console.log("after calls", stores());
console.log("bound shape", instanceBound.name, instanceBound.length, staticBound.name, staticBound.length,
  instanceWithThis.name, "asyncResource" in instanceBound);

console.log("runInAsyncScope", resource.runInAsyncScope(function (this: unknown, a: number, b: number) {
  return `${stores()} this=${String(this)} args=${a},${b}`;
}, "self", 3, 4));

const nestedRun = resource.bind(() => inner.run("i3", () => stores()) + " then " + stores());
console.log("nested run inside bound", outer.run("o4", nestedRun), stores());

const throwing = resource.bind(() => {
  throw new Error(stores());
});
outer.run("o5", () => {
  try {
    throwing();
  } catch (error) {
    console.log("bound throw", (error as Error).message, "restored", stores());
  }
});

try {
  resource.bind(1 as unknown as () => void);
} catch (error) {
  console.log("bind non-function", (error as { code: string }).code, (error as Error).message);
}
try {
  new AsyncResource(undefined as unknown as string);
} catch (error) {
  console.log("type", (error as { code: string }).code, (error as Error).message);
}
for (const options of [[], null]) {
  try {
    new AsyncLocalStorage(options as unknown as object);
    console.log("options accepted", String(options));
  } catch (error) {
    console.log("options", (error as { code: string }).code, (error as Error).message);
  }
}

await new Promise<void>((resolve) => {
  outer.run("timer", () => setTimeout(() => {
    console.log("bound in timer", instanceBound("t"), "timer context", stores());
    resolve();
  }, 1));
});
