// Bun utility APIs a Bun author tries first (docs/bun-api-probe.md). Each check prints one
// line, so a failure names itself and the rest still run.
async function check(name: string, body: () => unknown): Promise<void> {
  try {
    const value = await body();
    console.log(`ok ${name}${value === undefined ? "" : ": " + (typeof value === "string" ? value : Bun.inspect(value))}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await check("Bun.version", () => typeof Bun.version === "string" && Bun.version.split(".").length === 3);
await check("import.meta", () => [import.meta.dir === process.cwd(), import.meta.file, import.meta.main, import.meta.path.endsWith("/index.ts"), typeof import.meta.resolve("./index.ts")]);
await check("Bun.main", () => Bun.main.endsWith("/index.ts"));
await check("Bun.env", () => Bun.env === process.env && typeof Bun.env.PATH);
await check("Bun.argv", () => Array.isArray(Bun.argv) && Bun.argv.length >= 2);
await check("Bun.sleep", async () => {
  const start = performance.now();
  await Bun.sleep(20);
  return performance.now() - start >= 15;
});
await check("Bun.nanoseconds", () => {
  const a = Bun.nanoseconds();
  const b = Bun.nanoseconds();
  return typeof a === "number" && b >= a;
});
await check("Bun.inspect", () => Bun.inspect({ a: 1, nested: { list: [1, "two"], map: new Map([["k", 1]]) } }));
await check("Bun.inspect.custom", () => Bun.inspect({ [Bun.inspect.custom]: () => "custom!" }));
await check("Bun.inspect.table", () => Bun.inspect.table([{ a: 1, b: 2 }, { a: 3, b: 4 }]));
await check("Bun.deepEquals", () => [Bun.deepEquals({ a: [1] }, { a: [1] }), Bun.deepEquals({ a: 1 }, { a: 2 })]);
await check("Bun.escapeHTML", () => Bun.escapeHTML(`<a href="x">&'</a>`));
await check("Bun.stringWidth", () => [Bun.stringWidth("hello"), Bun.stringWidth("日本"), Bun.stringWidth("👋")]);
await check("Bun.hash", () => [Bun.hash("bun"), Bun.hash.wyhash("bun", 7n), Bun.hash.crc32("bun"), Bun.hash.adler32("bun"), Bun.hash.cityHash64("bun"), Bun.hash.xxHash32("bun"), Bun.hash.xxHash64("bun"), Bun.hash.xxHash3("bun"), Bun.hash.murmur32v3("bun"), Bun.hash.murmur64v2("bun")]);
await check("Bun.CryptoHasher sha256", () => new Bun.CryptoHasher("sha256").update("hello ").update("bun").digest("hex"));
await check("Bun.CryptoHasher algorithms", () => ["md5", "sha1", "sha512", "blake2b256", "sha3-256"].map(algorithm => new Bun.CryptoHasher(algorithm as Bun.SupportedCryptoAlgorithms).update("bun").digest("hex").slice(0, 16)));
await check("Bun.CryptoHasher hmac", () => new Bun.CryptoHasher("sha256", "secret").update("bun").digest("base64"));
await check("Bun.SHA256.hash", () => Bun.SHA256.hash("bun", "hex"));
await check("Bun.hash inputs", () => {
  const blob = new Blob(["bun"]);
  const thrown = (run: () => unknown) => { try { return run(); } catch (error) { return (error as { code?: string }).code; } };
  return [
    Bun.hash.xxHash32(blob), Bun.hash(blob), Bun.hash.crc32(blob), Bun.hash.xxHash32(new Uint16Array([1, 2])), Bun.hash.xxHash32(123),
    thrown(() => (Bun.hash.xxHash32 as unknown as () => number)()), thrown(() => (Bun.hash as unknown as () => bigint)()), thrown(() => Bun.hash.xxHash32(null as unknown as string)),
  ];
});
await check("Bun.hash seeds", () => [2 ** 64, 2 ** 70, Infinity, -1, -5, -(2 ** 70), -Infinity, NaN, 1.7, 2n ** 64n, -1n, "5"].map(seed => Bun.hash.xxHash64("bun", seed as number)).concat([Bun.hash("bun", 2 ** 64), Bun.hash.crc32("bun", 5)]));
await check("Bun.sha", () => {
  const target = new ArrayBuffer(32);
  const returned = Bun.sha("bun", target as unknown as "hex");
  return [Buffer.from(Bun.sha("bun")).toString("hex"), Bun.sha(new Blob(["bun"]), "hex"), returned === target, Buffer.from(target).toString("hex"), Bun.SHA256.hash(new Blob(["bun"]), "base64")];
});
await check("Bun.password argon2id", async () => {
  const hash = await Bun.password.hash("hunter2");
  assert(hash.startsWith("$argon2id$"), hash);
  return [await Bun.password.verify("hunter2", hash), await Bun.password.verify("wrong", hash)];
});
await check("Bun.password returns a pending promise", async () => {
  const pending = Bun.password.hash("hunter2", { algorithm: "argon2id", memoryCost: 4096, timeCost: 1 });
  const status = Bun.peek.status(pending);
  await pending;
  return status;
});
await check("Bun.password bcrypt", async () => {
  const hash = await Bun.password.hash("hunter2", { algorithm: "bcrypt", cost: 4 });
  assert(hash.startsWith("$2"), hash);
  return [await Bun.password.verify("hunter2", hash), Bun.password.verifySync("wrong", hash)];
});
await check("Bun.password sync", () => {
  const hash = Bun.password.hashSync("pw", { algorithm: "argon2id", memoryCost: 4096, timeCost: 1 });
  return Bun.password.verifySync("pw", hash);
});
await check("Bun.Glob", () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  return [glob.match("src/app.tsx"), glob.match("src/app.js"), new Bun.Glob("*.md").match("README.md")];
});
await check("Bun.Glob scan", async () => {
  await Bun.write("globbed/a.ts", "");
  await Bun.write("globbed/sub/b.ts", "");
  await Bun.write("globbed/c.js", "");
  return (await Array.fromAsync(new Bun.Glob("**/*.ts").scan("globbed"))).sort();
});
await check("Bun.semver", () => [Bun.semver.satisfies("1.2.3", "^1.0.0"), Bun.semver.satisfies("2.0.0", "~1.2"), Bun.semver.order("1.0.0", "1.0.1"), ["1.10.0", "1.2.0", "1.9.9"].sort(Bun.semver.order)]);
await check("Bun.TOML.parse", () => Bun.TOML.parse(`title = "bun"\n[owner]\nname = "x"\nlist = [1, 2]\n[[items]]\nid = 1\n`));
await check("Bun.YAML.parse", () => Bun.YAML.parse("name: bun\nlist:\n  - 1\n  - two\nnested:\n  ok: true\n"));
await check("Bun.YAML.stringify", () => Bun.YAML.stringify({ name: "bun", list: [1, 2] }));
await check("import toml/yaml/json5", async () => {
  await Bun.write("config.toml", `port = 3000\n`);
  await Bun.write("config.yaml", `name: yaml\n`);
  const toml = await import("./config.toml");
  const yaml = await import("./config.yaml");
  return [toml.default.port, yaml.default.name];
});
await check("Bun.randomUUIDv7", () => /^[0-9a-f-]{36}$/.test(Bun.randomUUIDv7()) && Bun.randomUUIDv7("hex").length);
await check("Bun.which", () => typeof Bun.which("bun"));
await check("Bun.fileURLToPath", () => [Bun.fileURLToPath("file:///a/b.ts"), Bun.pathToFileURL("/a/b.ts").href]);
await check("Bun.gzipSync", () => new TextDecoder().decode(Bun.gunzipSync(Bun.gzipSync(new TextEncoder().encode("zip me")))));
await check("Bun.deflateSync", () => new TextDecoder().decode(Bun.inflateSync(Bun.deflateSync(new TextEncoder().encode("deflate me")))));
await check("Bun.zstd", async () => new TextDecoder().decode(Bun.zstdDecompressSync(await Bun.zstdCompress(new TextEncoder().encode("zstd me")))));
await check("Bun.peek", () => [Bun.peek(Promise.resolve(5)), Bun.peek.status(new Promise(() => {}))]);
await check("Bun.ArrayBufferSink", () => {
  const sink = new Bun.ArrayBufferSink();
  sink.write("ab");
  sink.write(new Uint8Array([99]));
  return new TextDecoder().decode(sink.end() as ArrayBuffer);
});
await check("Bun.readableStreamToText", () => Bun.readableStreamToText(new Response("stream text").body!));
await check("Bun.Transpiler", () => new Bun.Transpiler({ loader: "ts" }).transformSync("const x: number = 1; export { x };").trim());
await check("Bun.Transpiler scan", () => new Bun.Transpiler({ loader: "tsx" }).scan(`import a from "a"; import type { T } from "t"; export const b = 1;`));
await check("HTMLRewriter", async () => {
  const rewriter = new HTMLRewriter()
    .on("a[href]", { element(el) { el.setAttribute("href", el.getAttribute("href")!.toUpperCase()); } })
    .on("p", { text(text) { if (text.text) text.replace(text.text.replace("old", "new")); } })
    .on("script", { element(el) { el.remove(); } });
  return await rewriter.transform(new Response(`<p>old text</p><a href="/x">x</a><script>bad()</script>`)).text();
});
await check("HTMLRewriter string", () => new HTMLRewriter().on("b", { element(el) { el.tagName = "strong"; } }).transform("<b>bold</b>"));
await check("Bun.cookie", () => {
  const map = new Bun.CookieMap("a=1; b=2");
  map.set("c", "3");
  return [map.get("a"), map.size, new Bun.Cookie("name", "value", { path: "/", httpOnly: true }).serialize()];
});
await check("structuredClone + Bun types", () => structuredClone({ d: new Date(0), m: new Map([[1, 2]]) }));
await check("fetch data url", async () => await (await fetch("data:text/plain,hi%20bun")).text());
await check("WebCrypto subtle digest", async () => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bun"))).toString("hex").slice(0, 16));
await check("crypto.randomUUID", () => crypto.randomUUID().length);
