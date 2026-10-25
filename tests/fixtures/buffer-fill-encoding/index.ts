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

function fillControl(label: string, ...args: unknown[]) {
  const buffer = Buffer.alloc(5, ".");
  try {
    const result = Reflect.apply(buffer.fill, buffer, args);
    console.log(label, result === buffer, buffer.toString("hex"));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    console.log(label, error.name, error.code, buffer.toString("hex"));
  }
}

fillControl("invalid encoding at end", "x", 5, "not-an-encoding");
fillControl("invalid encoding past end", "x", 6, "not-an-encoding");
fillControl("valid encoding at end", "é", 5, "latin1");
fillControl("valid encoding past end", "é", 6, "latin1");
fillControl("undefined start latin1 ignored", "é", undefined, "latin1");
fillControl("undefined start invalid encoding ignored", "é", undefined, "not-an-encoding");
