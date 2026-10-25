import { Buffer } from "node:buffer";

const bytes = Buffer.alloc(5, ".");
console.log("same buffer", bytes.fill("é", 1, "latin1") === bytes);
console.log("latin1 start", bytes.toString("hex"));
console.log("hex start", Buffer.alloc(5, ".").fill("6162", 1, "hex").toString("hex"));
console.log("hex whole", Buffer.alloc(5, ".").fill("6162", "hex").toString("hex"));
console.log("hex bounded", Buffer.alloc(5, ".").fill("6162", 1, 3, "hex").toString("hex"));
console.log("latin1 bounded", Buffer.alloc(5, ".").fill("é", 1, 4, "latin1").toString("hex"));
try {
  // @ts-expect-error Deliberately unknown encoding to verify runtime validation.
  Buffer.alloc(5).fill("x", 1, "not-an-encoding");
} catch (error) {
  if (!(error instanceof Error) || !("code" in error)) throw error;
  console.log("unknown encoding", error.name, error.code);
}
