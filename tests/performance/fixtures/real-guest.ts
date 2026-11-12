import path from "node:path";
import fs from "node:fs/promises";

// Deliberate guest input. All path, filesystem and module calls use the guest.
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
const picomatch = require("next/dist/compiled/picomatch");
const { defaultOverrides } = require("next/dist/server/require-hook");
const { TRACE_IGNORES } = require("next/dist/build/webpack/plugins/next-trace-entrypoints-plugin");
const mode = process.argv[2];
const root = process.cwd();
const marker = "BUN_WASM_PERF_RESULT ";

function control() {
  let value = 0;
  for (let index = 0; index < 100000; index++) value = (value + index) | 0;
  const expected = 704982704;
  if (value !== expected || path.resolve("a", "..", "b") !== `${root}/b`) throw new Error("guest positive control failed");
  console.log(marker + JSON.stringify({ mode: "control", value, cwd: root, path: path.resolve("b") }));
}

function tolerate(codes: readonly string[], fallback: null): (error: NodeJS.ErrnoException) => null;
function tolerate(codes: readonly string[], fallback: string): (error: NodeJS.ErrnoException) => string;
function tolerate(codes: readonly string[], fallback: string | null) {
  return (error: NodeJS.ErrnoException) => {
    if (error.code && codes.includes(error.code)) return fallback;
    throw error;
  };
}

interface TraceResult {
  fileList: Set<string>;
  esmFileList: Set<string>;
  warnings: Set<Error & { code?: string }>;
}

async function trace() {
  const anchor = [require.resolve("next/dist/server/require-hook")];
  const shared = Object.keys(defaultOverrides).map(id => require.resolve(id, { paths: anchor }));
  const entries = shared.concat([require.resolve("next/dist/server/next-server")], shared,
    [require.resolve("next/dist/compiled/next-server/server.runtime.prod")]);
  const runtime = (id: string) => `**/next/dist/compiled/next-server/${id}.runtime.prod.js`;
  const ignores: string[] = ["**/next/dist/compiled/next-server/**/*.dev.js", "**/next/dist/compiled/jest-worker/**/*",
    "**/next/dist/compiled/webpack/*", "**/node_modules/webpack5/**/*", "**/next/dist/server/lib/route-resolver*",
    "next/dist/compiled/semver/semver/**/*.js", "**/next/dist/compiled/@ampproject/toolbox-optimizer/**/*"].concat(TRACE_IGNORES,
    ["app-page-experimental", "app-page-turbo-experimental", "app-page-turbo", "app-route-experimental",
      "app-route-turbo-experimental", "app-route-turbo", "pages-api-turbo", "pages-turbo"].map(runtime));
  const isIgnored: (file: string) => boolean = picomatch(ignores, { contains: true, dot: true });
  const counts = { readFile: 0, readStringLength: 0, readlink: 0, stat: 0, ignore: 0 };
  const packages = ["next", "react", "react-dom", "@next/swc-wasm-nodejs"].map(id => {
    const pkg = require(`${id}/package.json`);
    return { name: pkg.name, version: pkg.version };
  });
  if (mode === "load") {
    console.log(marker + JSON.stringify({ mode, entries, ignores, packages }));
    return;
  }
  const result: TraceResult = await nodeFileTrace(entries, {
    base: root, processCwd: root, mixedModules: true, cache: { analysisCache: new Map() },
    async readFile(file: string) {
      counts.readFile++;
      const text = await fs.readFile(file, "utf8").catch(tolerate(["ENOENT", "EISDIR"], ""));
      counts.readStringLength += text.length;
      return text;
    },
    readlink(file: string) { counts.readlink++; return fs.readlink(file).catch(tolerate(["EINVAL", "ENOENT", "UNKNOWN"], null)); },
    stat(file: string) { counts.stat++; return fs.stat(file).catch(tolerate(["ENOENT", "ENOTDIR"], null)); },
    ignore(file: string) {
      counts.ignore++;
      return path.isAbsolute(file) && !file.startsWith(root) ? true : isIgnored(file);
    },
  });
  const warnings = Array.from(result.warnings, warning => ({ name: warning.name, code: warning.code ?? null, message: warning.message }));
  warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  console.log(marker + JSON.stringify({ mode, entries, ignores, packages,
    fileList: Array.from(result.fileList).sort(), esmFileList: Array.from(result.esmFileList).sort(), warnings, counts, stubUse: {} }));
}

async function main() {
  if (mode === "control") return control();
  if (mode !== "trace" && mode !== "load") throw new Error("usage: real-guest.ts control|trace|load");
  await trace();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
