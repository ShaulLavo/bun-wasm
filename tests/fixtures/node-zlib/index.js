const zlib = require("zlib");
const input = Buffer.from("hello zlib ".repeat(50));
for (const [pack, unpack] of [["gzipSync", "gunzipSync"], ["deflateSync", "inflateSync"], ["deflateRawSync", "inflateRawSync"]]) {
  const packed = zlib[pack](input);
  console.log(pack, packed.length < input.length, zlib[unpack](packed).equals(input));
}
console.log("gzip magic:", zlib.gzipSync("x").subarray(0, 3).toString("hex"));
console.log("unzip detects gzip:", zlib.unzipSync(zlib.gzipSync("auto")).toString());
// A gzip stream made by gzip(1): "hello\n".
const fromCli = Buffer.from("H4sIAAAAAAAAA8tIzcnJ5wIAIDA6NgYAAAA=", "base64");
console.log("gunzip external:", JSON.stringify(zlib.gunzipSync(fromCli).toString()));
console.log("Bun.gunzipSync:", new TextDecoder().decode(Bun.gunzipSync(Bun.gzipSync("bun gzip"))));
console.log("Bun.inflateSync:", new TextDecoder().decode(Bun.inflateSync(Bun.deflateSync("raw deflate"))));
try {
  zlib.inflateSync(Buffer.from("not compressed"));
} catch (err) {
  console.log("bad data throws:", err instanceof Error);
}
zlib.gzip("async", (err, buf) => console.log("callback:", err, zlib.gunzipSync(buf).toString()));
