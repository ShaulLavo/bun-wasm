const engine = Reflect.get(globalThis, "HermesInternal");
if (typeof engine !== "object" || engine === null) throw new Error("Expected the actual Hermes VM");
console.log("hello Hermes", 1 + 1);
