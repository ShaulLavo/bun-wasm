import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";

// node:crypto Hash and Hmac are Transform streams: writing data and ending the stream
// pushes the digest, as in Node's LazyTransform.
const hash = crypto.createHash("sha256");
console.log("instance", hash instanceof Transform, typeof hash.write, typeof hash.pipe);
console.log("plain update", crypto.createHash("sha256").update("abc").digest("hex"));

const ended = crypto.createHmac("sha256", "key");
ended.end("The quick brown fox");
console.log("hmac end + read", (ended.read() as Buffer).toString("hex"));

const encoded = crypto.createHash("md5");
encoded.setEncoding("hex");
encoded.write("some data ");
encoded.write(Buffer.from("to hash"));
encoded.end();
console.log("setEncoding hex", encoded.read());

const chunks: Buffer[] = [];
const viaData = crypto.createHash("sha1");
await new Promise<void>(resolve => {
  viaData.on("data", chunk => chunks.push(chunk as Buffer));
  viaData.on("end", () => resolve());
  viaData.write("a");
  viaData.end("b");
});
console.log("data event", chunks.length, Buffer.concat(chunks).toString("hex"));

const readable = crypto.createHash("sha512-256");
const fromReadable = await new Promise<string>(resolve => {
  readable.on("readable", () => {
    const value = readable.read() as Buffer | null;
    if (value) resolve(value.toString("hex"));
  });
  readable.end("readable event");
});
console.log("readable event", fromReadable);

const piped = await new Promise<string>(resolve => {
  const target = crypto.createHash("sha3-256");
  target.on("finish", () => resolve((target.read() as Buffer).toString("hex")));
  Readable.from([Buffer.from("piped "), Buffer.from("input")]).pipe(target);
});
console.log("pipe", piped);

const latin1 = crypto.createHmac("sha1", "k");
latin1.end("café", "latin1");
console.log("end with encoding", (latin1.read() as Buffer).toString("hex"), crypto.createHmac("sha1", "k").update("café", "latin1").digest("hex"));

const options = crypto.createHash("sha256", { highWaterMark: 4 } as crypto.HashOptions);
console.log("options", options.writableHighWaterMark, options.readableHighWaterMark);
