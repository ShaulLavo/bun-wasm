import { expect, test } from "bun:test";
import { createOptimizer } from "@builder.io/qwik/optimizer";

const root = new URL("../sandbox/template-qwik/", import.meta.url);

test("Qwik's client optimizer preserves the starter's render call", async () => {
  const optimizer = await createOptimizer();
  const code = await Bun.file(new URL("src/main.tsx", root)).text();
  const result = optimizer.transformModulesSync({
    input: [{ path: "main.tsx", code }],
    srcDir: "/home/user/src", rootDir: "/home/user",
    transpileTs: true, transpileJsx: true, mode: "dev", isServer: false,
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.modules[0]?.code).toContain("render(document,");

});

test("Qwik CSR preview uses Vite's static server without SSR middleware", async () => {
  const { default: config } = await import("../sandbox/template-qwik/vite.config");
  const preview = await config({ command: "serve", mode: "production", isPreview: true });
  expect(preview.plugins ?? []).toHaveLength(0);
});

test("Qwik loader is an HTML module entry so package sideEffects metadata cannot remove it", async () => {
  const html = await Bun.file(new URL("index.html", root)).text();
  expect(html).toContain('<script type="module" src="/node_modules/@builder.io/qwik/dist/qwikloader.js"></script>');
});
