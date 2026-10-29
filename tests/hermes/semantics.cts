const order: string[] = [];
process.nextTick(() => order.push("tick"));
Promise.resolve().then(() => order.push("promise"));
queueMicrotask(() => order.push("microtask"));
setTimeout(() => console.log("job order", order.join(",")), 1);
let rejections = 0;
process.on("unhandledRejection", reason => {
  if (reason !== "one rejection") throw new Error("rejection identity changed");
  rejections++;
});
Promise.reject("one rejection");
setTimeout(() => console.log("unhandled once", rejections), 2);
function recurse(): number { return 1 + recurse(); }
try { recurse(); } catch (error) { console.log("recursion", error instanceof RangeError); }
const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
const old = memory.buffer;
const view = new Uint8Array(old);
view[0] = 7;
memory.grow(1);
console.log("memory detach", old.byteLength, view.length, memory.buffer.byteLength, new Uint8Array(memory.buffer)[0]);
try { structuredClone(memory.buffer, { transfer: [memory.buffer] }); }
catch (error) { console.log("memory transfer refused", error instanceof Error && error.name === "DataCloneError"); }
console.log("memory remains", memory.buffer.byteLength);
process.exitCode = 7;
