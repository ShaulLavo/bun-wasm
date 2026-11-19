import fs from "node:fs";
import fsp from "node:fs/promises";
import { EventEmitter } from "node:events";

// FileHandle is an EventEmitter with Node 26's stream methods: createReadStream and
// createWriteStream hold the handle until they close, readableWebStream, pull, pullSync
// and writer lock it, and a closed handle reports Bun's "Bad file descriptor".
fs.writeFileSync("a.txt", "hello world\n");
const describe = (error: any) => `${error.name} ${error.code} ${error.syscall ?? "-"} ${error.message}`;

{
  const fh = await fsp.open("a.txt", "r");
  console.log("emitter", fh instanceof EventEmitter, typeof fh.fd, Object.keys(fh).filter(key => !key.startsWith("_")));
  await fh.close();
  for (const method of ["read", "write", "stat", "readFile", "writeFile", "appendFile", "truncate", "readv", "writev", "sync", "datasync"]) {
    await (fh as any)[method](Buffer.alloc(1)).then(() => console.log(method, "ok"), (error: unknown) => console.log(method, describe(error)));
  }
  for (const method of ["createReadStream", "createWriteStream", "readableWebStream", "writer", "pull", "pullSync"]) {
    try { (fh as any)[method](); console.log(method, "ok"); } catch (error) { console.log(method, describe(error)); }
  }
  console.log("close again", await fh.close(), fh.fd);
}

{
  const fh = await fsp.open("a.txt", "r");
  let data = "";
  const readable = fh.createReadStream({ encoding: "utf8" });
  readable.on("data", chunk => (data += chunk));
  await new Promise(resolve => readable.on("close", resolve));
  console.log("createReadStream", JSON.stringify(data), fh.fd);
  await fh.close();
}

{
  const fh = await fsp.open("w.txt", "w");
  const stream = fh.createWriteStream();
  const events: string[] = [];
  fh.on("close", () => events.push("handle close"));
  stream.on("finish", () => events.push("finish"));
  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.on("close", resolve);
    stream.write("written ");
    stream.end("through a handle");
  });
  console.log("createWriteStream", JSON.stringify(fs.readFileSync("w.txt", "utf8")), fh.fd, events.join(","));
  await fh.close();
}

{
  // close() while a stream holds the handle waits for the stream to release it.
  const fh = await fsp.open("deferred.txt", "w");
  const stream = fh.createWriteStream();
  stream.write("deferred close");
  const closed = fh.close();
  console.log("deferred fd still open", fh.fd !== -1);
  await closed;
  console.log("deferred", JSON.stringify(fs.readFileSync("deferred.txt", "utf8")), fh.fd, stream.destroyed);
}

{
  const fh = await fsp.open("a.txt", "r");
  const reader = fh.readableWebStream().getReader();
  const parts: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(`${value instanceof Uint8Array}:${Buffer.from(value).toString()}`);
  }
  console.log("readableWebStream", JSON.stringify(parts));
  try { fh.readableWebStream(); } catch (error) { console.log("readableWebStream again", describe(error)); }
  await fh.close();
  console.log("readableWebStream closed", fh.fd);
}

{
  const fh = await fsp.open("a.txt", "r");
  const chunks: string[] = [];
  for await (const batch of fh.pull({ chunkSize: 5 })) chunks.push(Buffer.concat(batch).toString());
  console.log("pull", JSON.stringify(chunks));
  for (const batch of fh.pullSync({ start: 6, limit: 3 })) chunks.push(Buffer.concat(batch).toString());
  console.log("pullSync", JSON.stringify(chunks));
  await fh.close();
}

{
  for (const options of [{ autoClose: 1 }, { start: 1.5 }, { start: "1" }, 5, { limit: 0 }, { chunkSize: 0 }]) {
    const fh = await fsp.open("writer.txt", "w");
    try { fh.writer(options as any); console.log("writer ok"); } catch (error) { console.log("writer", describe(error)); }
    await fh.close();
  }
  let fh = await fsp.open("writer.txt", "w+");
  const limited = fh.writer({ start: 0, limit: 2 });
  await limited.write("abc").catch(error => console.log("limit", describe(error)));
  console.log("limit writes", await limited.write("ab"), limited.writeSync("c"));
  limited.fail();
  await limited.write("x").catch(error => console.log("after fail", describe(error)));
  const writer = fh.writer();
  try { writer.writeSync(5 as any); } catch (error) { console.log("writeSync(5)", describe(error)); }
  try { await writer.write(5 as any); } catch (error) { console.log("write(5)", describe(error)); }
  console.log("writer", await writer.writev(["q", new Uint8Array([65])]), writer.writevSync(["r"]), await writer.end(), await writer.end(), writer.endSync());
  await fh.close();
  console.log("writer file", JSON.stringify(fs.readFileSync("writer.txt", "utf8")));

  fh = await fsp.open("writer.txt", "w");
  const failing = fh.writer({ autoClose: true });
  const pending = failing.write(Buffer.alloc(1 << 20, 65));
  failing.fail(new Error("stop"));
  console.log("open after fail", fh.fd !== -1);
  await pending;
  console.log("after write", fh.fd, fs.statSync("writer.txt").size);

  fh = await fsp.open("writer.txt", "w");
  const ending = fh.writer({ autoClose: true });
  const written = ending.write("abc");
  console.log("end", await ending.end(), await written, fh.fd);

  fh = await fsp.open("writer.txt", "r+");
  const unused = fh.writer();
  await fh.close();
  await unused.write("a").catch(error => console.log("stale write", describe(error)));
  try { unused.writeSync("a"); } catch (error) { console.log("stale writeSync", describe(error)); }
}

{
  await fsp.writeFile("x.txt", "data");
  await using reading = await fsp.open("x.txt", "r");
  console.log("promises.readFile(handle)", (await fsp.readFile(reading)).toString());
  await using appending = await fsp.open("x.txt", "a");
  await fsp.appendFile(appending, "+more");
  await using writing = await fsp.open("y.txt", "w");
  await fsp.writeFile(writing, "written");
  console.log("handles", fs.readFileSync("x.txt", "utf8"), fs.readFileSync("y.txt", "utf8"));
}
