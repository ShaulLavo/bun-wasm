// Bun.file / Bun.write, node:fs, TextEncoder/Decoder, Buffer, process basics.
import { readFileSync, writeFileSync, existsSync } from "fs";

await_main();
async function await_main() {
  const n = await Bun.write("out.txt", "hello from Bun.write\n");
  console.log("wrote", n, "bytes");
  console.log(JSON.stringify(await Bun.file("out.txt").text()));
  await Bun.write("data.json", JSON.stringify({ items: [1, 2, 3], ok: true }));
  const j = await Bun.file("data.json").json();
  console.log(j.items.reduce((a: number, b: number) => a + b, 0), j.ok);
  writeFileSync("fs.txt", "line1\nline2\n");
  console.log(readFileSync("fs.txt", "utf8").split("\n").length, existsSync("fs.txt"), existsSync("nope.txt"));
  const buf = readFileSync("fs.txt");
  console.log(buf.length, buf.toString("utf8", 0, 5), buf.toString("hex").slice(0, 10));
  try {
    readFileSync("missing.txt", "utf8");
  } catch (e: any) {
    console.log(e.code, e.syscall);
  }
  const bytes = new TextEncoder().encode("héllo ✓");
  console.log(bytes.length, Array.from(bytes.slice(0, 3)), new TextDecoder().decode(bytes));
  console.log(Buffer.from("bun").toString("base64"), Buffer.from("YnVu", "base64").toString());
  console.log(typeof Bun.version, process.argv.slice(2), typeof process.env, process.cwd() === "/" || process.cwd().length > 0);
}
