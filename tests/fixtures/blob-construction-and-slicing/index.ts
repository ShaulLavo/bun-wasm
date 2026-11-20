import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Blob and File construction, types and slicing, as in Bun.
const show = (value: unknown) => (value instanceof Blob ? `Blob(${value.size}, ${JSON.stringify(value.type)})` : JSON.stringify(value));
const attempt = (run: () => unknown) => {
  try {
    return show(run());
  } catch (error: any) {
    return `throws ${error.name} ${error.code} ${JSON.stringify(error.message)}`;
  }
};

// Parts: an Array, or a single ArrayBuffer or view; anything else throws.
for (const [label, make] of [
  ["string", () => new Blob("123" as any)],
  ["number", () => new Blob(42 as any)],
  ["plain object", () => new Blob({} as any)],
  ["Set", () => new Blob(new Set(["a"]) as any)],
  ["File with a string", () => new File("123" as any, "123")],
  ["Uint8Array", () => new Blob(new Uint8Array([49, 50]) as any)],
  ["ArrayBuffer", () => new Blob(new Uint8Array([49, 50, 51]).buffer as any)],
  ["DataView", () => new Blob(new DataView(new Uint8Array([49]).buffer) as any)],
  ["null", () => new Blob(null as any)],
  ["no options", () => new Blob(["x"], null as any)],
] as const) {
  console.log("parts", label, attempt(make));
}
console.log("Uint8Array text:", await new Blob(Buffer.from("1234") as any).text(), await new File(Buffer.from("1234") as any, "f.txt").text());

// Types: printable ASCII only; Bun's interned types keep Bun's value and are what a slice inherits.
for (const type of ["Text/HTML", "text/plain", "TEXT/PLAIN", "image/tiff", "application/x-www-form-urlencoded", "application/x-not-registered", "ሴ", "a\tb", "", "application/json"]) {
  const blob = new Blob(["abc"], { type });
  console.log("type", JSON.stringify(type), JSON.stringify(blob.type), "slice:", JSON.stringify(blob.slice(0, 1).type), "slice X/Y:", JSON.stringify(blob.slice(0, 1, "X/Y").type), "slice invalid:", JSON.stringify(blob.slice(0, 1, "ሴ").type));
}

// Bounds: only numbers move them (NaN is 0), a string is the type, negatives count from the end.
const blob = new Blob(["Bun", "Foo"]);
const sizes = (b: Blob) =>
  [b.slice().size, b.slice(NaN).size, b.slice(0, NaN).size, b.slice(0, Infinity).size, b.slice(-Infinity).size, b.slice(-1, 3).size, b.slice(100, 3).size, b.slice(1.7, 4.2).size, b.slice(Symbol() as any, "-123").size, b.slice(null as any, "-123").size, b.slice(2n as any).size, b.slice(true as any).size].join(",");
console.log("Blob bounds:", sizes(blob));
console.log("Blob slice texts:", await blob.slice(1, 4).slice(-2, 3).text(), await blob.slice(-5, 4).slice(-3, 3).text(), JSON.stringify(blob.slice("text/plain;charset=utf-8").type), show(new Blob([]).slice(0, 1, "text/html")));

const dir = mkdtempSync("blob-fixture-");
writeFileSync(join(dir, "slice.txt"), "BunFoo");
const file = Bun.file(join(dir, "slice.txt"));
console.log("Bun.file bounds:", sizes(file));
console.log("Bun.file slice:", show(file.slice(0, 3, "Text/HTML")), await file.slice(1, 4).slice(-2, 3).text(), JSON.stringify(file.slice("text/plain;charset=utf-8").type));
console.log("missing file slice:", show(Bun.file(join(dir, "missing")).slice(1, 3)), show(Bun.file(join(dir, "missing")).slice(-1, 3)));

// lastModified goes through ToNumber, and NaN is 0.
for (const value of [NaN, "not a number", {}, null, "", false, true, "123", -1, 1.5]) {
  console.log("lastModified", JSON.stringify(value) ?? String(value), new File([], "n", { lastModified: value as any }).lastModified);
}
console.log("lastModified valueOf throws:", attempt(() => new File([], "n", { lastModified: { valueOf() { throw new Error("boom"); } } as any })));

// name: a Blob takes only a string (or clears it with null); a File's name comes from the constructor.
const named = new Blob([]) as any;
const seen = [named.name];
named.name = "logo.svg";
seen.push(named.name);
named.name = 10;
seen.push(named.name);
named.name = null;
seen.push(named.name);
console.log("Blob name:", JSON.stringify(seen), Object.getOwnPropertyNames(named).length);
const renamed = new File(["x"], "a.txt") as any;
renamed.name = "b.txt";
console.log("File name:", renamed.name, new File([], 42 as any).name, new File([Bun.file(join(dir, "missing"))], "bar.txt").name);
const nulled = Bun.file(join(dir, "missing"));
nulled.name = null as any;
console.log("Bun.file name set to null:", JSON.stringify(nulled.name));
// A type that is not a string is ignored.
console.log("type 5:", JSON.stringify(new Blob([], { type: 5 as any }).type), JSON.stringify(new File([], "f", { type: 5 as any }).type));
const used = new Response("x");
await used.text();
console.log("used body:", await used.text().catch((error: any) => `${error.name} ${error.code} ${error.message}`));

// A UTF-16LE byte order mark is decoded by text() and json(), even at an odd offset.
const odd = new Blob([new Uint8Array([0x41, 0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])]).slice(1);
console.log("UTF-16 text:", await odd.text(), await new Blob([new Uint8Array([0x41, 0xff, 0xfe, 0x34, 0x00, 0x32, 0x00])]).slice(1).json(), JSON.stringify(await new Blob([new Uint8Array([0xff, 0xfe, 0x68])]).text()), JSON.stringify(await new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x68])]).text()));
