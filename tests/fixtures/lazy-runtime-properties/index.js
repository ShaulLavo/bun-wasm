// Bun properties, Buffer and Date that the runtime sets up on first use act like plain ones.
const keys = Object.keys(Bun);
const lazy = ["Glob", "TOML", "YAML", "JSON5", "JSONC", "Transpiler", "dns", "plugin", "Archive", "ArrayBufferSink", "Cookie", "CookieMap", "JSONL", "concatArrayBuffers"];
console.log(lazy.every(name => keys.includes(name)));
console.log(lazy.every(name => Object.getOwnPropertyDescriptor(Bun, name).enumerable));
console.log(Bun.Glob === Bun.Glob, new Bun.Glob("*.ts").match("a.ts"));
console.log(Bun.TOML.parse("a = 1").a, Bun.JSONC.parse("[1, /* two */ 2]").join());
console.log(lazy.map(name => typeof Bun[name]).join());
console.log(new Uint8Array(Bun.concatArrayBuffers([new Uint8Array([1]), new Uint8Array([2])])).join());
console.log(typeof Bun.dns.lookup, new Bun.CookieMap("a=1").get("a"));
console.log(typeof Buffer, Buffer.from("hi").toString("hex"), Buffer === require("buffer").Buffer);
console.log(Date.prototype.constructor === Date, new Date(0).toISOString(), typeof Date.now());
