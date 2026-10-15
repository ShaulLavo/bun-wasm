class BloomFilter {
  static import(data) { return data; }
}
console.log(BloomFilter.import(42));
const a = { import(x) { return x; } };
console.log("properties", { import: 1 }.import, a?.import(2), a.import?.(3));
const text = "import(never)";
const raw = String.raw`import(never)`;
// import("never")
/* import("never") */
console.log("literals", text, /import\(never\)/.test(text), `import(never) ${a.import(4)}`, raw);
if (true) /import\(never\)/.test(text) && console.log("regex statement", true);
console.log("commented access", a. /* import("never") */ import(5), a
  .import(6));
