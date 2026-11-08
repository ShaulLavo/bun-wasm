import assert from "node:assert/strict";
import { session, playwright, ready, run, writeFile } from "./playground.mjs";

const compiler = `import { transformSync } from "@babel/core";
import solid from "babel-preset-solid";
const filename = "node_modules/@solidjs/start/dist/server/StartServer.jsx";
const source = await Bun.file(filename).text();
const result = transformSync(source, {
  filename, babelrc: false, configFile: false,
  presets: [[solid, { generate: "ssr", hydratable: true }]],
});
if (!result?.code?.includes("ssr")) throw new Error("Missing SSR output");
console.log("solid SSR compiled");`;
const s = session("bun-wasm-solid-stack-");
try {
  const browser = await s.launch(playwright.firefox);
  const page = await browser.newPage();
  const base = process.env.BUN_WASM_TEST_URL ?? await s.serve();
  await page.goto(`${base}?template=solidstart&engine=jsc&prompt=off&mode=memory`);
  await ready(page);
  const installed = await run(page, "bun install", 90_000);
  assert.equal(installed.code, 0, installed.output);
  await writeFile(page, "/home/user/solid-ssr-stack.ts", compiler);
  const prefix = process.env.BUDGET_KIB ? `BUN_WASM_STACK_KIB=${process.env.BUDGET_KIB} ` : "";
  const compiled = await run(page, `${prefix}bun run solid-ssr-stack.ts`, 90_000);
  console.log(JSON.stringify({ browser: browser.version(), budget: process.env.BUDGET_KIB ?? "host-policy", ...compiled }));
  assert.equal(compiled.code, 0, compiled.output);
  assert.match(compiled.output, /solid SSR compiled/);
} finally {
  await s.cleanup();
}
