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
await check("Bun.hash seeds", () => [2 ** 64, 2 ** 70, Infinity, -1, -5, -(2 ** 63) - 2048, -(2 ** 64) - 4096, -(2 ** 64), -(2 ** 70), -1e300, -Infinity, NaN, 1.7, -1.7, 2n ** 64n, -1n, "5"].map(seed => Bun.hash.xxHash64("bun", seed as number)).concat([Bun.hash("bun", 2 ** 64), Bun.hash("bun", -(2 ** 63) - 2048), Bun.hash.crc32("bun", 5), Bun.hash.crc32("bun", -(2 ** 63) - 2048)]));
await check("Bun.sha", () => {
  const target = new ArrayBuffer(32);
  const returned = Bun.sha("bun", target as unknown as "hex");
  return [Buffer.from(Bun.sha("bun")).toString("hex"), Bun.sha(new Blob(["bun"]), "hex"), returned === target, Buffer.from(target).toString("hex"), Bun.SHA256.hash(new Blob(["bun"]), "base64")];
});
await check("Bun hash buffer output and digest retry", () => {
  const sha = Bun.sha("bun", "buffer" as "hex") as unknown as Buffer;
  const sha256 = Bun.SHA256.hash("bun", "buffer" as "hex") as unknown as Buffer;
  const hasher = new Bun.SHA256().update("bun");
  let bogus;
  try { hasher.digest("bogus" as "hex"); } catch (error) { bogus = (error as { code?: string }).code; }
  const retried = hasher.digest("hex");
  const short = new Bun.SHA256().update("bun");
  let tooSmall;
  try { short.digest(new Uint8Array(4) as unknown as "hex"); } catch (error) { tooSmall = (error as { code?: string }).code; }
  return [Buffer.isBuffer(sha), sha.toString("hex"), Buffer.isBuffer(sha256), bogus, retried, tooSmall, short.digest("hex"), Buffer.isBuffer(new Bun.SHA1().update("x").digest("buffer" as "hex")), Buffer.isBuffer(Bun.sha("bun", "BUFFER" as "hex"))];
});
await check("Bun.password argon2id", async () => {
  const hash = await Bun.password.hash("hunter2");
  assert(hash.startsWith("$argon2id$"), hash);
  return [await Bun.password.verify("hunter2", hash), await Bun.password.verify("wrong", hash)];
});
await check("Bun.password empty verify settles at once", async () => {
  const empty = [Bun.password.verify("x", ""), Bun.password.verify("", "$2b$10$abcdefghijklmnopqrstuu")];
  return [empty.map(promise => Bun.peek.status(promise)), await Promise.all(empty), Bun.password.verifySync("x", "")];
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
await check("Bun.CSRF", () => {
  const token = Bun.CSRF.generate("secret");
  const session = Bun.CSRF.generate("secret", { sessionId: "user-1", encoding: "hex", algorithm: "SHA512" });
  return [
    Bun.CSRF.verify(token, { secret: "secret" }),
    Bun.CSRF.verify(token, { secret: "wrong" }),
    Bun.CSRF.verify(session, { secret: "secret", sessionId: "user-1", encoding: "hex", algorithm: "sha512" }),
    Bun.CSRF.verify(session, { secret: "secret", sessionId: "user-2", encoding: "hex", algorithm: "sha512" }),
    Bun.CSRF.verify(Bun.CSRF.generate()),
    token.length,
  ];
});
await check("Bun.CSRF ignores replaced globals", () => {
  const random = crypto.getRandomValues;
  const now = Date.now;
  try {
    crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T) => array) as typeof crypto.getRandomValues;
    Date.now = () => 0;
    const a = Bun.CSRF.generate("secret", { encoding: "hex" });
    const b = Bun.CSRF.generate("secret", { encoding: "hex" });
    const defaults = [Bun.CSRF.generate(), Bun.CSRF.generate()];
    Date.now = now;
    // A zero timestamp would have expired; equal nonces would make equal tokens.
    return [a !== b, a.slice(16, 48) !== "0".repeat(32), Bun.CSRF.verify(a, { secret: "secret", encoding: "hex" }), defaults.every(token => Bun.CSRF.verify(token))];
  } finally {
    crypto.getRandomValues = random;
    Date.now = now;
  }
});
await check("Bun.CSRF options", () => {
  const code = (run: () => unknown) => { try { return run(); } catch (error) { return `${(error as Error).name} ${(error as { code?: string }).code}: ${(error as Error).message}`; } };
  return [
    Bun.CSRF.generate("s", { encoding: "HEX" }).length, Bun.CSRF.generate("s", { encoding: "BASE64URL" }).length, Bun.CSRF.generate("s", { encoding: "base64" }).length,
    Bun.CSRF.generate("s", { algorithm: "SHA-384" }).length, Bun.CSRF.generate("s", { algorithm: "sha-512/256" }).length,
    code(() => Bun.CSRF.generate(null as unknown as string)), code(() => Bun.CSRF.generate(5 as unknown as string)), code(() => Bun.CSRF.generate("")),
    code(() => Bun.CSRF.generate("s", { sessionId: 5 as unknown as string })), code(() => Bun.CSRF.generate("s", { sessionId: "" })),
    code(() => Bun.CSRF.generate("s", { algorithm: "sha512_256" as "sha256" })), code(() => Bun.CSRF.generate("s", { algorithm: null as unknown as "sha256" })),
    code(() => Bun.CSRF.generate("s", { encoding: "utf8" as "hex" })), code(() => Bun.CSRF.generate("s", { expiresIn: -1 })),
    code(() => Bun.CSRF.generate("s", { expiresIn: 1.5 })), code(() => Bun.CSRF.generate("s", { expiresIn: "5" as unknown as number })),
    code(() => Bun.CSRF.verify(5 as unknown as string)), code(() => Bun.CSRF.verify("")), code(() => Bun.CSRF.verify("x", { secret: 5 as unknown as string })),
    code(() => Bun.CSRF.verify("x", { secret: "s", maxAge: {} as unknown as number })),
  ];
});
await check("Bun.CSRF callable options and signed hex", () => {
  const generateOptions = Object.assign(() => undefined, { encoding: "hex", sessionId: "user-1", expiresIn: 60_000 });
  const verifyOptions = Object.assign(() => undefined, { secret: "s", encoding: "hex", sessionId: "user-1" });
  const token = Bun.CSRF.generate("s", generateOptions as unknown as Bun.CSRFGenerateOptions);
  const wrongSession = Object.assign(() => undefined, { secret: "s", encoding: "hex", sessionId: "user-2" });
  // The timestamp's first byte is 00; "+0" decodes to it only with a sign-accepting parser.
  const signed = `+0${token.slice(2)}`;
  return [
    token.length, token.slice(0, 2), Bun.CSRF.verify(token, verifyOptions as unknown as Bun.CSRFVerifyOptions),
    Bun.CSRF.verify(token, wrongSession as unknown as Bun.CSRFVerifyOptions), Bun.CSRF.verify(signed, verifyOptions as unknown as Bun.CSRFVerifyOptions),
  ];
});
await check("Bun.CSRF decoding", () => {
  const hex = Bun.CSRF.generate("s", { encoding: "hex", algorithm: "sha512" });
  const url = Bun.CSRF.generate("s");
  const hexOptions = { secret: "s", encoding: "hex", algorithm: "sha512" } as const;
  return [
    hex.length, Bun.CSRF.verify(`${hex}\0`, hexOptions), Bun.CSRF.verify(`${hex}\0\0`, hexOptions), Bun.CSRF.verify(hex.toUpperCase(), hexOptions),
    Bun.CSRF.verify(`${hex}00`, hexOptions), Bun.CSRF.verify(url, { secret: "s", encoding: "base64" }), Bun.CSRF.verify(`${url}\0`, { secret: "s" }),
    Bun.CSRF.verify(`  ${url}\n`, { secret: "s" }), Bun.CSRF.verify(`!!!!${url}`, { secret: "s" }), Bun.CSRF.verify(`${url}AAAA`, { secret: "s" }),
    Bun.CSRF.verify(`${url}${"A".repeat(24)}`, { secret: "s" }), Bun.CSRF.verify(url, 5 as unknown as Bun.CSRFVerifyOptions),
  ];
});
await check("Bun.markdown.html", () => Bun.markdown.html("# Title\n\n| a | b |\n|---|---|\n| 1 | ~~2~~ |\n\n- [x] done\n", { headings: true }));
await check("Bun.markdown.ansi", () => Bun.markdown.ansi("# Hi\n\n*em* and `code`", { colors: false }));
await check("structuredClone + Bun types", () => structuredClone({ d: new Date(0), m: new Map([[1, 2]]) }));
await check("fetch data url", async () => await (await fetch("data:text/plain,hi%20bun")).text());
await check("WebCrypto subtle digest", async () => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bun"))).toString("hex").slice(0, 16));
await check("crypto.randomUUID", () => crypto.randomUUID().length);
