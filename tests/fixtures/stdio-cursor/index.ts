import { emitCursorSequence, verifyDelegation, verifyNoop } from "./contract.ts";

for (const stream of [process.stdout, process.stderr]) {
  verifyDelegation(stream);
  await verifyNoop(stream);
  await emitCursorSequence(stream);
  stream.write("\n");
}
console.log("stdout and stderr cursor bytes, write return values, callback identity and tick order");
