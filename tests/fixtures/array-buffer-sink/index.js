import { ArrayBufferSink } from "bun";

function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log(name);
}

function bytes(value) {
  return Array.from(new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength)).join(",");
}

const sink = ArrayBufferSink();
check("callable constructor", typeof sink === "object" && ArrayBufferSink.prototype === undefined);
check("utf8 count", sink.write("é😋") === 6);
const source = new Uint8Array([1, 2, 3]);
check("view count", sink.write(new DataView(source.buffer, 1, 1)) === 1);
source[1] = 9;
check("normal flush", sink.flush() === 0);
check("owned bytes", bytes(sink.end()) === "195,169,240,159,152,139,2");
check("write after end", sink.write("x") === 1 && sink.end().byteLength === 0);
sink.start({ stream: true, asUint8Array: true });
sink.write("a");
const flushed = sink.flush(true);
check("stream flush", flushed instanceof Uint8Array && bytes(flushed) === "97" && sink.flush().byteLength === 0);
sink.write("b");
check("typed end", sink.end() instanceof Uint8Array && sink.end() instanceof ArrayBuffer);
sink.start({});
sink.write("c");
check("empty options preserve modes", sink.flush() instanceof Uint8Array);
sink.start({ highWaterMark: Infinity });
sink.write("d");
check("watermark resets modes", sink.flush() === 0 && sink.end() instanceof ArrayBuffer);
sink.start();
for (const value of [null, undefined, 1, {}]) {
  let rejected = false;
  try { sink.write(value); } catch (error) { rejected = error instanceof TypeError; }
  check("invalid input", rejected);
}
sink.close();
for (const method of ["write", "flush", "end", "start"]) {
  let rejected = false;
  try { sink[method]("x"); } catch (error) { rejected = /already been closed/.test(error.message); }
  check("closed " + method, rejected);
}
check("close is idempotent", sink.close() === undefined);
for (const key of ["highWaterMark", "asUint8Array", "stream"]) {
  const other = new ArrayBufferSink();
  let rejected = false;
  try { other.start({ get [key]() { other.close(); return key === "highWaterMark" ? 1024 : true; } }); }
  catch (error) { rejected = /already been closed/.test(error.message); }
  check("reentrant " + key, rejected);
}
