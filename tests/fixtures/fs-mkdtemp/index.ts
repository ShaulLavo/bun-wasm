import fs from "node:fs";
import { join } from "node:path";

// mkdtemp honours its encoding option, rejects an empty prefix with EINVAL and reports a
// missing parent as ENOENT with syscall "mkdtemp", as Bun does. process.binding("uv")
// carries libuv's error table.
const suffix = /[A-Za-z0-9]{6}'$/;
function show(label: string, error: any) {
  const { name, code, errno, syscall } = error;
  console.log(label, JSON.stringify({ name, code, errno, syscall, message: error.message.replace(suffix, "XXXXXX'"), keys: Object.keys(error) }));
}

fs.mkdirSync("base");
const prefix = join("base", "enc-dé-");
const prefixBytes = Buffer.from(prefix);

try { fs.mkdtempSync(""); } catch (error) { show("sync empty", error); }
try { fs.mkdtempSync(join("base", "no", "such", "dir-")); } catch (error) { show("sync missing parent", error); }
try { fs.mkdtempSync(Buffer.from("")); } catch (error) { console.log("sync empty buffer", (error as Error).name, (error as Error).message); }

const asBuffer = fs.mkdtempSync(prefix, { encoding: "buffer" }) as unknown as Buffer;
console.log("buffer", Buffer.isBuffer(asBuffer), asBuffer.subarray(0, prefixBytes.length).equals(prefixBytes), asBuffer.length - prefixBytes.length, fs.existsSync(asBuffer));
console.log("buffer shorthand", Buffer.isBuffer(fs.mkdtempSync(prefix, "buffer")));
for (const encoding of ["hex", "base64", "base64url", "latin1", "utf8"] as const) {
  const result = fs.mkdtempSync(prefix, { encoding });
  const decoded = Buffer.from(result, encoding);
  console.log(encoding, typeof result, decoded.subarray(0, prefixBytes.length).equals(prefixBytes), decoded.length - prefixBytes.length, fs.existsSync(decoded));
}
console.log("buffer prefix", typeof fs.mkdtempSync(Buffer.from(prefix)));

const uv = process.binding("uv") as any;
console.log("uv", uv === process.binding("uv"), uv.UV_ENOENT, uv.UV_EINVAL, uv.UV_EOF, uv.UV_UNKNOWN, Object.keys(uv).length, Object.keys(uv)[0], Object.keys(uv).at(-1));
console.log("uv errname", uv.errname(-2), uv.errname(-9999), uv.errname(1), uv.errname("x"));
console.log("uv map", uv.getErrorMap().size, uv.getErrorMap().get(-13), uv.getErrorMap().get(-4095), uv.getErrorMap() === uv.getErrorMap());

await new Promise<void>(resolve => fs.mkdtemp("", (error, folder) => { show("callback empty", error); console.log("callback folder", folder); resolve(); }));
await new Promise<void>(resolve => fs.mkdtemp(join("base", "no", "dir-"), (error, folder) => {
  show("callback missing parent", error);
  console.log("callback errno is UV_ENOENT", error?.errno === uv.UV_ENOENT, folder);
  resolve();
}));
await new Promise<void>(resolve => fs.mkdtemp(prefix, { encoding: "buffer" }, (error, folder) => { console.log("callback buffer", error, Buffer.isBuffer(folder)); resolve(); }));
await fs.promises.mkdtemp("").catch(error => show("promise empty", error));
console.log("promise hex", Buffer.from(await fs.promises.mkdtemp(prefix, "hex"), "hex").subarray(0, prefixBytes.length).equals(prefixBytes));
console.log("promise buffer", Buffer.isBuffer(await fs.promises.mkdtemp(prefix, { encoding: "buffer" })));
console.log("created", fs.readdirSync("base").length);
