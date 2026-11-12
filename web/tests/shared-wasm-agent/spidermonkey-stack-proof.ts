// Test-only observation of the real worker's imports, before Waffle instantiates each member.
// Values are not replaced: the production Wasi, group carver and linker all run unchanged.
let observing = false;
let stackBytes: number | undefined;
let pointer: WebAssembly.ImportValue | undefined;
let low: number | undefined;
let high: number | undefined;
self.addEventListener("message", (event: MessageEvent) => {
  observing = event.data?.engine === "spidermonkey" && !!event.data?.memoryGroup;
  stackBytes = event.data?.memoryGroup?.stackBytes;
});
const NativeInstance = WebAssembly.Instance;
WebAssembly.Instance = new Proxy(NativeInstance, {
  construct(Target, args: ConstructorParameters<typeof WebAssembly.Instance>) {
    if (!observing) return new Target(...args);
    const imports = args[1];
    const bottom = imports?.["GOT.mem"]?.__stack_low;
    const top = imports?.["GOT.mem"]?.__stack_high;
    const current = imports?.env?.__stack_pointer;
    if (bottom instanceof WebAssembly.Global && top instanceof WebAssembly.Global) {
      pointer = current;
      low = Number(bottom.value) >>> 0;
      high = Number(top.value) >>> 0;
    }
    if (current instanceof WebAssembly.Global && pointer) self.postMessage({ type: "spidermonkey-stack-proof", low, high, stackBytes, pointer: Number(current.value) >>> 0, samePointer: current === pointer });
    return new Target(...args);
  },
});

export {};
