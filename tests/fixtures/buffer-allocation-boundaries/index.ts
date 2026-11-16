import { Buffer, isAscii } from "node:buffer";
import { boundaryChecks } from "./checks.ts";

for (const check of boundaryChecks(Buffer, isAscii, Bun.concatArrayBuffers)) {
  check.run();
  console.log("pass", check.name);
}
