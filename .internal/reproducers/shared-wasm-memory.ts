const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
if (!(memory.buffer instanceof SharedArrayBuffer)) throw new Error("Expected a shared WebAssembly memory buffer");
console.log("shared WebAssembly memory", memory.buffer.byteLength);
