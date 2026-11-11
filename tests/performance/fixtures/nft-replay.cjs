// nft-harness.js: the Next 15.5.6 build trace (`@vercel/nft` over the server entries) as a
// self-contained workload that runs unchanged in the bun-wasm guest and in a bare SpiderMonkey
// `js` shell. Plain JavaScript on purpose: the shell loads it directly.
//
//   record FIXTURE   (bun-wasm guest only) Runs the trace with the real file callbacks through the
//                    harness's own module loader and writes FIXTURE: every module source the
//                    loader used, the entries and ignore globs, every callback result, and the
//                    expected file list hash and callback counts.
//   replay FIXTURE   (guest or shell) Runs the same trace from FIXTURE alone. No file system, no
//                    Node or Bun module is used after the fixture is read.
//
// Both modes load nft, acorn, picomatch and the Node builtins nft needs (path, events, util,
// assert, os, buffer, stream, url, constants) from the copies Next ships under
// next/dist/compiled, through the loader below, and give them the same `process`, timers and
// `Buffer`. The guest's own node:path, node:fs and module loader are therefore not part of the
// replayed workload; RESULT.md states what that leaves out.
"use strict";
const inShell = typeof scriptArgs !== "undefined" && typeof process === "undefined";
const hostArgs = inShell ? scriptArgs : process.argv.slice(2);
const hostRequire = inShell ? null : require;
const readText = inShell ? file => read(file) : file => hostRequire("fs").readFileSync(file, "utf8");
const say = inShell ? print : text => console.log(text);
const [mode, fixturePath] = hostArgs;
// `load` is replay without the trace: it reads the fixture and loads the modules, then stops. Its
// counters are the start-up cost to subtract from a replay run.
if (!["record", "replay", "load"].includes(mode) || !fixturePath) throw new Error("usage: nft-harness.js record|replay|load FIXTURE");
if (mode === "record" && inShell) throw new Error("record needs the bun-wasm guest");

const polyfills = {
  path: "next/dist/compiled/path-browserify", events: "next/dist/compiled/events", util: "next/dist/compiled/util",
  assert: "next/dist/compiled/assert", os: "next/dist/compiled/os-browserify", buffer: "next/dist/compiled/buffer",
  stream: "next/dist/compiled/stream-browserify", constants: "next/dist/compiled/constants-browserify",
};
// node:url as far as nft uses it: file URLs only. The bare shell has no URL class, so both
// environments get this one. Anything that is not a file URL throws, which nft treats as
// "not statically known".
class FileUrl {
  constructor(input, base) {
    const text = String(input instanceof FileUrl ? input.href : input);
    if (text.startsWith("file://")) this.pathname = text.slice(7);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(text)) throw new TypeError(`unsupported URL ${text}`);
    else if (base === undefined) throw new TypeError(`invalid URL ${text}`);
    else this.pathname = load("path", root).resolve(new FileUrl(base).pathname, "..", text);
    this.protocol = "file:";
    this.href = `file://${this.pathname}`;
  }
  toString() { return this.href; }
}
const urlShim = {
  URL: FileUrl,
  pathToFileURL: file => new FileUrl(`file://${encodeURI(file)}`),
  fileURLToPath: url => decodeURI(new FileUrl(url).pathname),
};
const stubbed = ["fs", "child_process", "module"];
const fixture = mode !== "record" ? JSON.parse(readText(fixturePath)) : { modules: {}, stubUse: {}, fsCalls: {}, readFile: {}, readlink: {}, stat: {} };
const root = mode !== "record" ? fixture.root : process.cwd();

const microtask = (fn, args) => { Promise.resolve().then(() => fn(...args)); };
const shimProcess = {
  env: {}, platform: "linux", arch: "wasm32", version: "v24.0.0", versions: { node: "24.0.0" }, argv: [], config: {},
  cwd: () => root, nextTick: (fn, ...args) => microtask(fn, args), emitWarning() {}, on() {}, once() {}, off() {},
  stderr: { write() {} }, stdout: { write() {} }, getuid: () => 1000,
};
let timerId = 0;
const shimGlobals = {
  setTimeout: (fn, _ms, ...args) => { microtask(fn, args); return ++timerId; },
  setImmediate: (fn, ...args) => { microtask(fn, args); return ++timerId; },
  clearTimeout() {}, clearImmediate() {},
  // Only npm's progress bar asks for an interval, at load time, and the trace never shows it.
  setInterval: () => ++timerId, clearInterval() {},
  console: { log: say, error: say, warn: say, info() {}, debug() {} },
};

const loaded = new Map();
function moduleSource(key, id, directory) {
  if (mode !== "record") {
    const entry = fixture.modules[key];
    if (!entry) throw new Error(`module ${key} is not in the fixture`);
    return entry;
  }
  const file = hostRequire.resolve(id, { paths: [directory] });
  return fixture.modules[key] = { file, source: readText(file) };
}
// node:fs outside the three callbacks. nft's package special cases (sharp and others) read a few
// files synchronously. Record mode forwards each call to the real module and stores its result
// by function name and arguments; replay answers from that table and fails on anything else.
function packValue(value) {
  if (value === undefined) return { kind: "undefined" };
  if (value === null || typeof value !== "object") return { kind: "plain", value };
  if (typeof value.isFile === "function") return { kind: "stats", file: value.isFile(), directory: value.isDirectory(), link: value.isSymbolicLink() };
  if (value instanceof Uint8Array) return { kind: "bytes", base64: Buffer.from(value).toString("base64") };
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return { kind: "plain", value };
  throw new Error("the harness cannot record this fs result");
}
function unpackValue(packed) {
  if (packed.kind === "undefined") return undefined;
  if (packed.kind === "plain") return packed.value;
  if (packed.kind === "stats") return { isFile: () => packed.file, isDirectory: () => packed.directory, isSymbolicLink: () => packed.link };
  return load("buffer", root).Buffer.from(packed.base64, "base64");
}
const packError = error => ({ code: error.code, message: error.message });
const unpackError = packed => Object.assign(new Error(packed.message), { code: packed.code });
// Callback-style fs function (glob's readdir and lstat): the callback runs in a later microtask
// in both modes' replays; record mode waits for the real call.
function recordedFsCallback(name) {
  const real = mode === "record" ? hostRequire("fs")[name.split(".")[1]] : undefined;
  return (...args) => {
    const done = args.pop();
    if (typeof done !== "function") throw new Error(`the harness needs a callback for ${name}`);
    const key = `${name}(${JSON.stringify(args)})`;
    const answer = entry => entry.error ? done(unpackError(entry.error)) : done(null, unpackValue(entry.result));
    if (mode === "record") {
      real(...args, (error, value) => answer(fixture.fsCalls[key] = error ? { error: packError(error) } : { result: packValue(value) }));
      return;
    }
    const entry = fixture.fsCalls[key];
    if (!entry) throw new Error(`fs call ${key} is not in the fixture`);
    microtask(answer, [entry]);
  };
}
function recordedFs(name) {
  const real = mode === "record" ? name.split(".").slice(1).reduce((owner, key) => owner?.[key], hostRequire("fs")) : undefined;
  return (...args) => {
    const key = `${name}(${JSON.stringify(args)})`;
    if (mode === "record") {
      try { fixture.fsCalls[key] = { result: packValue(real(...args)) }; }
      catch (error) { fixture.fsCalls[key] = { error: { code: error.code, message: error.message } }; }
    }
    const entry = fixture.fsCalls[key];
    if (!entry) throw new Error(`fs call ${key} is not in the fixture`);
    if (entry.error) throw Object.assign(new Error(entry.error.message), { code: entry.error.code });
    return unpackValue(entry.result);
  };
}
// child_process and module are never executed by the trace. The stub lets nft capture references
// at load time and fails loudly on any call. fs functions ending in Sync are recorded as above.
function stub(name) {
  return new Proxy(function () {}, {
    get(target, key) {
      if (typeof key !== "string" || key === "prototype") return target[key];
      if (Object.hasOwn(target, key)) return target[key];
      if (name === "module" && key === "builtinModules") return fixture.builtinModules ??= hostRequire("module").builtinModules;
      if (name === "fs" && key.endsWith("Sync")) return target[key] = recordedFs(`${name}.${key}`);
      if (name === "fs" && ["readdir", "lstat", "stat", "realpath", "readlink"].includes(key)) return target[key] = recordedFsCallback(`${name}.${key}`);
      return stub(`${name}.${key}`);
    },
    apply() {
      fixture.stubUse[name] = (fixture.stubUse[name] ?? 0) + 1;
      throw new Error(`the harness does not provide ${name}()`);
    },
  });
}
// Loads one module for a requiring directory. Relative requests are keyed by that directory.
function load(request, directory) {
  const id = polyfills[request] ?? request;
  const key = id.startsWith(".") ? `${directory}::${id}` : id;
  if (loaded.has(key)) return loaded.get(key).exports;
  if (request === "url") return urlShim;
  if (stubbed.includes(request)) { const exports = stub(request); loaded.set(key, { exports }); return exports; }
  const { file, source } = moduleSource(key, id, directory);
  const module = { exports: {} };
  loaded.set(key, module);
  if (file.endsWith(".json")) { module.exports = JSON.parse(source); return module.exports; }
  const here = file.slice(0, file.lastIndexOf("/"));
  const names = ["module", "exports", "require", "__filename", "__dirname", "process", "Buffer", "global"].concat(Object.keys(shimGlobals));
  const run = Function(...names, `${source}\n//# sourceURL=${file}`);
  const buffer = id === polyfills.buffer ? undefined : load("buffer", root).Buffer;
  run.call(module.exports, module, module.exports, child => load(child, here), file, here, shimProcess, buffer, globalThis, ...Object.values(shimGlobals));
  return module.exports;
}
const shimRequire = id => load(id, root);

function hashList(list) {
  let hash = 0x811c9dc5;
  for (const item of list) {
    for (let index = 0; index < item.length; index++) hash = Math.imul(hash ^ item.charCodeAt(index), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ 10, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function liveInputs() {
  const fs = hostRequire("fs/promises");
  const { defaultOverrides } = hostRequire("next/dist/server/require-hook");
  const { TRACE_IGNORES } = hostRequire("next/dist/build/webpack/plugins/next-trace-entrypoints-plugin");
  const anchor = [hostRequire.resolve("next/dist/server/require-hook")];
  const shared = Object.keys(defaultOverrides).map(name => hostRequire.resolve(name, { paths: anchor }));
  const entries = shared.concat([hostRequire.resolve("next/dist/server/next-server")], shared,
    [hostRequire.resolve("next/dist/compiled/next-server/server.runtime.prod")]);
  const runtime = name => `**/next/dist/compiled/next-server/${name}.runtime.prod.js`;
  const starterExcludes = ["app-page-experimental", "app-page-turbo-experimental", "app-page-turbo", "app-route-experimental",
    "app-route-turbo-experimental", "app-route-turbo", "pages-api-turbo", "pages-turbo"].map(runtime);
  const ignores = ["**/next/dist/compiled/next-server/**/*.dev.js", "**/next/dist/compiled/jest-worker/**/*",
    "**/next/dist/compiled/webpack/*", "**/node_modules/webpack5/**/*", "**/next/dist/server/lib/route-resolver*",
    "next/dist/compiled/semver/semver/**/*.js", "**/next/dist/compiled/@ampproject/toolbox-optimizer/**/*"].concat(TRACE_IGNORES, starterExcludes);
  const tolerate = (codes, fallback) => error => { if (codes.includes(error?.code)) return fallback; throw error; };
  Object.assign(fixture, { root, entries, ignores });
  return {
    readFile: file => fs.readFile(file, "utf8").catch(tolerate(["ENOENT", "EISDIR"], "")).then(text => fixture.readFile[file] = text),
    readlink: file => fs.readlink(file).catch(tolerate(["EINVAL", "ENOENT", "UNKNOWN"], null)).then(target => fixture.readlink[file] = target),
    stat: file => fs.stat(file).catch(tolerate(["ENOENT", "ENOTDIR"], null))
      .then(stats => { fixture.stat[file] = stats && { file: stats.isFile(), directory: stats.isDirectory() }; return stats; }),
  };
}

function replayInputs() {
  const missing = name => file => { throw new Error(`${name} ${file} is not in the fixture`); };
  const lookup = (name, table) => async file => {
    await null;
    return Object.hasOwn(table, file) ? table[file] : missing(name)(file);
  };
  const stat = lookup("stat", fixture.stat);
  return {
    readFile: lookup("readFile", fixture.readFile),
    readlink: lookup("readlink", fixture.readlink),
    stat: file => stat(file).then(entry => entry && { isFile: () => entry.file, isDirectory: () => entry.directory }),
  };
}

async function main() {
  const loadStarted = Date.now();
  const inputs = mode === "record" ? liveInputs() : replayInputs();
  const { nodeFileTrace } = shimRequire("next/dist/compiled/@vercel/nft");
  const picomatch = shimRequire("next/dist/compiled/picomatch");
  const path = shimRequire("path");
  const isIgnored = picomatch(fixture.ignores, { contains: true, dot: true });
  const counts = { readFile: 0, readBytes: 0, readlink: 0, stat: 0, ignore: 0 };
  if (mode === "load") { say(JSON.stringify({ mode, shell: inShell, loadMs: Date.now() - loadStarted, modules: Object.keys(fixture.modules).length })); return; }
  const started = Date.now();
  const result = await nodeFileTrace(fixture.entries, {
    base: root, processCwd: root, mixedModules: true, cache: { analysisCache: new Map() },
    async readFile(file) { counts.readFile++; const text = await inputs.readFile(file); counts.readBytes += text.length; return text; },
    readlink(file) { counts.readlink++; return inputs.readlink(file); },
    stat(file) { counts.stat++; return inputs.stat(file); },
    ignore(file) { counts.ignore++; return path.isAbsolute(file) && !file.startsWith(root) ? true : isIgnored(file); },
  });
  const files = Array.from(result.fileList).sort();
  const outcome = { files: files.length, fileListHash: hashList(files), warnings: result.warnings.size, counts };
  if (mode === "record") {
    fixture.expected = outcome;
    hostRequire("fs").writeFileSync(fixturePath, JSON.stringify(fixture));
  }
  const matches = mode === "record" || JSON.stringify(outcome) === JSON.stringify(fixture.expected);
  say(JSON.stringify({ mode, shell: inShell, loadMs: started - loadStarted, traceMs: Date.now() - started, matchesFixture: matches,
    ...outcome, modules: Object.keys(fixture.modules).length, stubUse: fixture.stubUse }));
  if (!matches) throw new Error("replay result differs from the recorded trace");
}

main().catch(error => {
  say(`harness failed: ${error && error.stack ? `${error}\n${error.stack}` : error}`);
  if (inShell) quit(1);
  process.exit(1);
});
