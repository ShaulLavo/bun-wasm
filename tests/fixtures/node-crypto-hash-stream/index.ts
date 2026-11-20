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

// Ending the stream caches the digest without finalizing a Hash; an Hmac finalizes and
// later digests are empty. Bun's JSHash.cpp and JSHmac.cpp states.
const outcome = (run: () => unknown) => {
  try {
    const value = run();
    return Buffer.isBuffer(value) ? `buffer ${value.length}` : typeof value === "string" ? `"${value.slice(0, 16)}"` : "returned";
  } catch (error) {
    return (error as { code?: string }).code;
  }
};
for (const algorithm of ["sha256", "sha3-256", "shake128"]) {
  const expected = crypto.createHash(algorithm).update("abc").digest("hex");
  const state = crypto.createHash(algorithm);
  state.update("abc");
  state.end();
  const streamed = (state.read() as Buffer).toString("hex") === expected;
  console.log(
    "after end",
    algorithm,
    streamed,
    outcome(() => state.update("late")),
    outcome(() => state.update("").update(Buffer.alloc(0))),
    outcome(() => state.copy()),
    outcome(() => state.digest("hex")),
    outcome(() => state.digest("hex")),
    outcome(() => state.update("")),
  );
}
const digested = crypto.createHash("sha256");
digested.update("abc");
digested.digest();
const pushed = await new Promise<Buffer>(resolve => {
  const chunks: Buffer[] = [];
  digested.on("data", chunk => chunks.push(chunk));
  digested.on("end", () => resolve(Buffer.concat(chunks)));
  digested.end();
});
console.log("end after digest", pushed.toString("hex").slice(0, 16), outcome(() => digested.update("d")), outcome(() => digested.copy()));
const hmac = crypto.createHmac("sha1", "key").update("data");
console.log("hmac digest twice", outcome(() => hmac.digest("hex")), outcome(() => hmac.digest("hex")), outcome(() => hmac.digest()), outcome(() => hmac.update("x")));
const ab = new ArrayBuffer(8);
const detached = new Uint8Array(ab);
ab.transfer();
console.log("detached", crypto.createHash("sha256").update(detached).digest("hex") === crypto.createHash("sha256").digest("hex"), crypto.createHmac("sha256", detached).update("m").digest("hex") === crypto.createHmac("sha256", Buffer.alloc(0)).update("m").digest("hex"));
// crypto.Hmac warns with DEP0181; keep stderr empty as the fixture runner expects.
process.noDeprecation = true;
const Hmac = crypto.Hmac as unknown as (algorithm: string, key: string) => object;
console.log("Hmac without new", Hmac("sha256", "Node") instanceof crypto.Hmac);
console.log("createHmac checks", outcome(() => crypto.createHmac(null as never, "k")), outcome(() => crypto.createHmac("sha1", null as never)));
