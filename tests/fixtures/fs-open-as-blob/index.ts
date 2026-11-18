import fs, { openAsBlob, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const path = join(tmpdir(), "fs-open-as-blob.txt");
writeFileSync(path, "hello blob");

console.log(typeof openAsBlob, openAsBlob.name, fs.openAsBlob === openAsBlob);
const pending = openAsBlob(path);
console.log(pending instanceof Promise);
const blob = await pending;
console.log(blob instanceof Blob, blob.size === statSync(path).size, JSON.stringify(blob.type));
console.log(await blob.text());

const typed = await openAsBlob(path, { type: "text/plain" });
console.log(JSON.stringify(typed.type), await typed.slice(6).text());

const fromUrl = await openAsBlob(new URL(`file://${path}`));
console.log(fromUrl.size);
