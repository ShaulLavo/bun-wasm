// A dev server that reloads modules drops large values held in reference cycles: module
// objects, their functions and their source. 1.5 GiB of such garbage passes through a guest
// whose linear memory stops at 1 GiB (crates/bunwasm-cli/max-memory.txt), so the engine must
// count large blocks at their real size when it decides to collect cycles.
const blockBytes = 8 * 2 ** 20;
const rounds = 192;
let checksum = 0;
for (let i = 0; i < rounds; i++) {
  const owner: { self?: object; bytes: Uint8Array } = { bytes: new Uint8Array(blockBytes) };
  owner.self = owner;
  owner.bytes[i] = i;
  checksum += owner.bytes[i];
}
console.log("cyclic garbage MiB", (blockBytes * rounds) / 2 ** 20, "checksum", checksum);
