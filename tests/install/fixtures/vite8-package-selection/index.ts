import assert from "node:assert/strict";

console.log("guest", JSON.stringify({ platform: process.platform, arch: process.arch, versions: process.versions }));
await import("./parse-env.ts");

function dump(error: unknown, depth = 0): void {
  console.error("blocker", depth, String(error), error instanceof Error ? error.stack : "");
  if (depth >= 6 || !(error instanceof Error)) return;
  if (error.cause) dump(error.cause, depth + 1);
  if (error instanceof AggregateError) error.errors.forEach(cause => dump(cause, depth + 1));
}

interface LightningCss {
  transform(options: { filename: string; code: Uint8Array; minify?: boolean }): { code: Uint8Array };
}

function verifyLightningCss(compiler: LightningCss): void {
  const result = compiler.transform({ filename: "input.css", code: Buffer.from("a { color: red }"), minify: true });
  assert(!(result instanceof Promise), "Lightning CSS transform stays synchronous");
  assert.equal(Buffer.from(result.code).toString(), "a{color:red}");
  assert.throws(() => compiler.transform({ filename: "bad.css", code: Buffer.from("a { color: rgb( }") }));
}

for (const name of ["lightningcss", "rolldown", "oxc-parser", "oxc-transform"]) {
  try {
    const compiler = await import(name);
    console.log("import", name, Object.keys(compiler));
    if (name === "lightningcss") verifyLightningCss(compiler);
    console.log("pass", name);
  } catch (error) {
    console.error("failed", name);
    dump(error);
    process.exitCode = 1;
  }
}
