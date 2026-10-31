import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const compiler: typeof import("@next/swc-wasm-nodejs") = require("@next/swc-wasm-nodejs");
const metadata: unknown = JSON.parse(readFileSync(require.resolve("@next/swc-wasm-nodejs/package.json"), "utf8"));
if (!metadata || typeof metadata !== "object" || !("version" in metadata) || metadata.version !== "15.5.6") throw new Error("Wrong SWC version");
const result: unknown = compiler.transformSync("const value: number = 42;", { filename: "probe.ts", jsc: { parser: { syntax: "typescript" } } });
if (!result || typeof result !== "object" || !("code" in result) || typeof result.code !== "string" || !result.code.includes("42") || result.code.includes(": number")) throw new Error("SWC did not transform TypeScript");
process.stdout.write(`swc-wasm ${metadata.version} transformed TypeScript\n`);
