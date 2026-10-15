const descriptor = Object.getOwnPropertyDescriptor(globalThis, "gc");
let calls = 0;
Object.defineProperty(globalThis, "gc", {
  configurable: true,
  value() {
    if (++calls > 1) throw new Error("native GC reentered the user wrapper");
    return Bun.gc(true);
  },
});
try {
  Bun.gc(true);
  if (calls !== 0) throw new Error("Bun.gc called the user GC wrapper");
  globalThis.gc();
  if (calls !== 1) throw new Error("the GC wrapper did not run once");
} finally {
  if (descriptor) Object.defineProperty(globalThis, "gc", descriptor);
  else delete globalThis.gc;
}
console.log("host GC captured before user code");
