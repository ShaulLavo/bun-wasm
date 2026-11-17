import { Buffer, isAscii, isUtf8 } from "node:buffer";
import { boundaryChecks } from "./checks.ts";

for (const check of boundaryChecks(Buffer, { isAscii, isUtf8 }, Bun.concatArrayBuffers)) {
  check.run();
  console.log("pass", check.name);
}
