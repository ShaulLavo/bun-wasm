export {};

function require(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function rejects(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
  throw new Error("Expected allocation rejection");
}

const buffer = new ArrayBuffer(16, { maxByteLength: 1073741824 });
const view = new Uint8Array(buffer);
view.set([1, 2, 3, 4]);
rejects(() => buffer.resize(1073741824));
require(buffer.byteLength === 16 && view[3] === 4, "Failed resize changed existing storage");
rejects(() => buffer.transfer(1073741824));
require(buffer.byteLength === 16 && view[3] === 4, "Failed transfer detached or changed existing storage");
buffer.resize(65537);
require(view.length === 65537 && view[65536] === 0 && view[0] === 1, "Growth after allocation rejection failed");

for (const wide of [2 ** 32, 2 ** 32 + 16, 2 ** 40]) {
  rejects(() => buffer.transferToFixedLength(wide));
  require(buffer.byteLength === 65537 && view[0] === 1, "Wide fixed transfer wrapped or detached");
}

if (typeof SharedArrayBuffer === "function") {
  require(new SharedArrayBuffer(16).byteLength === 16, "Fixed SharedArrayBuffer changed");
  rejects(() => new SharedArrayBuffer(0, { maxByteLength: 0 }));
  rejects(() => new SharedArrayBuffer(16, { maxByteLength: 32 }));
}

console.log("JSC allocation failures preserve resizable backing");
