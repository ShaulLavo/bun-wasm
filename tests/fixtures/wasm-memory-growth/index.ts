// Go's wasm runtime (esbuild-wasm) grows its memory in 4 MiB arenas. Inside the 512 MiB wasm32
// guest a WebAssembly.Memory must be able to reach 200 MiB, which needs each growth to reserve
// only what it adds rather than doubling its reservation.
const memory = new WebAssembly.Memory({ initial: 321 });
const arena = 64;
let grew = 0;
while (memory.buffer.byteLength < 200 * 2 ** 20) {
  memory.grow(arena);
  grew++;
}
const view = new Uint8Array(memory.buffer);
view[view.length - 1] = 7;
console.log("pages", memory.buffer.byteLength / 65536, "growths", grew, "last byte", view[view.length - 1], "fresh byte", view[view.length - 2]);
