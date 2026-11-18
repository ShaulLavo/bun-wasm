import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

// AsyncLocalStorage follows Node's frame semantics: defaultValue, SameValue short-circuits,
// disable() deleting the binding from the current frame only, and run() restoring by value.
const show = (value: unknown) => (typeof value === "number" && Number.isNaN(value) ? "NaN" : String(value));

const withDefault = new AsyncLocalStorage({ defaultValue: "def", name: "named" });
console.log("defaultValue", withDefault.run("x", () => withDefault.getStore()), withDefault.getStore(), withDefault.name);
const plain = new AsyncLocalStorage();
console.log("name", JSON.stringify(plain.name), "NaN store", show(plain.run(NaN, () => plain.getStore())));

const disabled = new AsyncLocalStorage({ defaultValue: "D" });
disabled.enterWith("v");
disabled.disable();
console.log("disable falls back to defaultValue", disabled.getStore());
console.log("run on a disabled storage", disabled.run("Y", () => disabled.getStore()), disabled.getStore());

const same = new AsyncLocalStorage();
same.enterWith("A");
same.run("A", () => same.enterWith("B"));
console.log("same-value run keeps enterWith", same.getStore());
same.disable();

const nested = new AsyncLocalStorage();
nested.run("outer", () => {
  nested.run("inner", () => nested.disable());
  console.log("restored after inner disable", nested.getStore());
  nested.run(2, () => nested.enterWith(3));
  console.log("restored after inner enterWith", nested.getStore());
  nested.run("scoped", () => {
    using _scope = nested.withScope("scope");
    console.log("withScope", nested.getStore());
  });
  console.log("restored after withScope", nested.getStore());
});
console.log("outside", nested.getStore());

const a = new AsyncLocalStorage();
const b = new AsyncLocalStorage();
a.run("outer", () => {
  b.run(2, () => {
    const before = AsyncLocalStorage.snapshot();
    a.run(1, () => b.run(5, () => {}));
    const after = AsyncLocalStorage.snapshot();
    b.disable();
    console.log("disable after run", before(() => b.getStore()), after(() => b.getStore()), b.getStore(), a.getStore());
  });
});

a.enterWith(1);
const older = new AsyncResource("older");
b.enterWith("x");
older.runInAsyncScope(() => a.disable());
console.log("disable in an older frame", a.getStore(), older.runInAsyncScope(() => b.run(2, () => a.getStore())));
a.disable();
b.disable();

try {
  AsyncLocalStorage.bind(1 as never);
} catch (error) {
  console.log("bind", (error as Error & { code: string }).code, (error as Error).message);
}
const bound = a.run("bound", () => AsyncLocalStorage.bind((x: string) => `${x}:${a.getStore()}`));
console.log("bound call", bound("arg"), a.getStore());

const iterator = Array.prototype[Symbol.iterator];
try {
  a.enterWith("v");
  delete (Array.prototype as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  console.log("no iterator", a.run("v", (x: string, y: string) => `${x}/${y}`, "x", "y"));
} finally {
  Array.prototype[Symbol.iterator] = iterator;
  a.disable();
}

const timer = new AsyncLocalStorage();
timer.run("t", () => setTimeout(() => console.log("timer", timer.getStore()), 1));
await timer.run("p", async () => {
  await null;
  console.log("await", timer.getStore());
});
