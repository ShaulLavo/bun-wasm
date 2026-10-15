import { readFileSync, writeFileSync } from "node:fs";

writeFileSync("small.txt", "before");
console.log("before:", readFileSync("small.txt", "utf8"));
const bytes = new Uint8Array(48 * 1024 * 1024);
bytes[0] = 17;
bytes[bytes.length - 1] = 29;
writeFileSync("large.bin", bytes);
const result = readFileSync("large.bin");
console.log("large:", result.length, result[0], result[result.length - 1]);
writeFileSync("small.txt", "after");
console.log("after:", readFileSync("small.txt", "utf8"));
console.log("hash:", Bun.hash("tiny") === Bun.hash("tiny"));
