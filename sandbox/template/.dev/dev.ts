// The dev server for this app: `bun dev.ts` (or `bun run dev`). Plain Bun APIs, so it runs on
// native Bun as well as inside bun.wasm.
//
// - Source files (.tsx, .ts, .jsx, .js) are transpiled one at a time by Bun's bundler (Bun.build,
//   every import left external) with React Fast Refresh, so components call $RefreshReg$.
//   Their relative imports are rewritten to URLs with a ?t=<version> query.
// - The dependencies in DEPS are bundled once, at startup, into browser ES modules under /@deps/,
//   and index.html gets an import map pointing at them, plus the HMR client (hmr-client.js). Both live in .dev/,
//   which the sandbox file tree hides: they are the sandbox's plumbing, not the app.
// - POST /@hmr/update {path, text} writes a file and works out what to update: the changed
//   module, or the nearest importers that only export components (React refreshes those in
//   place, keeping state). CSS swaps its <style>. Anything else reloads the page.
// - The client long-polls GET /@hmr/events?since=<id> for those updates and for build errors.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";

const startupAt = performance.now();
function startup(phase: string, duration = 0): void {
  if (process.env.BUN_WASM_STARTUP) console.log(`[bunwasm:startup] ${JSON.stringify({ phase, duration, at: Date.now() })}`);
}
startup("dev-start");

// dev.ts lives in .dev/ (hidden from the sandbox file tree); the app is the folder above it.
const root = join(import.meta.dir, "..");
const port = Number(process.env.PORT || 5173);
const requireDep = createRequire(import.meta.url);

/** Bare imports the app may use. Add a package (or a subpath of one) here to use it. */
const DEPS = ["react", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-refresh/runtime"];
const SOURCE = /\.(tsx|ts|jsx|js|mjs)$/;
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", ".css"];
const DEFINE = { "process.env.NODE_ENV": JSON.stringify("development") };

const TYPES: Record<string, string> = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain;charset=utf-8",
};

// The preview runs in a cross-origin isolated page, so its documents need COEP of their own.
const ISOLATION = { "cross-origin-embedder-policy": "require-corp", "cross-origin-opener-policy": "same-origin" };

// ---------- dependencies ----------

const deps = new Map<string, string>(); // /@deps/<file> -> code
const importMap: Record<string, string> = {};
const depsFile = join(root, "node_modules/.dev/deps.json");

function depName(spec: string): string {
  return spec.replace(/[^\w.-]+/g, "__");
}

/** CommonJS packages (React is one) get an ES wrapper with real named exports. */
function wrapper(spec: string): string {
  const exported = Object.keys(requireDep(spec)).filter((name) => name !== "default" && name !== "__esModule" && /^[A-Za-z_$][\w$]*$/.test(name));
  const lines = [`import * as m from ${JSON.stringify(spec)};`, `export default m.default ?? m;`];
  if (exported.length) lines.push(`export const { ${exported.join(", ")} } = m.default ?? m;`);
  return lines.join("\n") + "\n";
}

async function bundleDeps(): Promise<void> {
  const started = performance.now();
  if (restoreDeps()) {
    startup("deps-cached", performance.now() - started);
    return;
  }
  startup("bundling-react", performance.now() - startupAt);
  // Give the runtime a turn to flush the progress line before the synchronous wasm build.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const dir = join(root, "node_modules/.dev");
  mkdirSync(dir, { recursive: true });
  const entries = DEPS.map((spec) => {
    const file = join(dir, `${depName(spec)}.js`);
    writeFileSync(file, wrapper(spec));
    return file;
  });
  const result = await Bun.build({ entrypoints: entries, splitting: true, target: "browser", format: "esm", define: DEFINE });
  for (const output of result.outputs) deps.set(output.path.replace(/^.*\//, ""), await output.text());
  for (const spec of DEPS) importMap[spec] = `/@deps/${depName(spec)}.js`;
  writeFileSync(depsFile, JSON.stringify({ deps: Object.fromEntries(deps), importMap }));
  startup("bundled-react", performance.now() - started);
  const size = Array.from(deps.values()).reduce((n, code) => n + code.length, 0);
  console.log(`\x1b[2m  deps: ${DEPS.length} modules bundled (${(size / 1024).toFixed(0)} KB) in ${Math.round(performance.now() - started)} ms\x1b[0m`);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function restoreDeps(): boolean {
  if (!existsSync(depsFile)) return false;
  try {
    if (!process.env.BUN_WASM_DEPS_KEY) return false;
    const cached: unknown = JSON.parse(readFileSync(depsFile, "utf8"));
    if (!cached || typeof cached !== "object" || !("deps" in cached) || !("importMap" in cached)) return false;
    if (!isStringRecord(cached.deps) || !isStringRecord(cached.importMap)) return false;
    const cachedImports = cached.importMap;
    const cachedDeps = cached.deps;
    if (!DEPS.every((spec) => cachedImports[spec] === `/@deps/${depName(spec)}.js` && typeof cachedDeps[`${depName(spec)}.js`] === "string")) return false;
    for (const [name, code] of Object.entries(cached.deps)) deps.set(name, code);
    Object.assign(importMap, cached.importMap);
    return true;
  } catch {
    return false;
  }
}

// ---------- the module graph ----------

interface ModuleInfo {
  /** Bumped on every change; part of the URLs importers use. */
  version: number;
  /** Files this one imports (absolute paths). */
  imports: Set<string>;
  /** Every export is a component React Refresh registered: React can swap it in place. */
  boundary: boolean;
  /** The ids its components are registered under ("src/App.tsx:App"). */
  refreshIds: string;
}

const modules = new Map<string, ModuleInfo>();
const importers = new Map<string, Set<string>>();
/** Build errors by file, shown in the preview's overlay until fixed. */
const errors = new Map<string, string>();

function info(file: string): ModuleInfo {
  let mod = modules.get(file);
  if (!mod) modules.set(file, (mod = { version: 0, imports: new Set(), boundary: false, refreshIds: "" }));
  return mod;
}

function setImports(file: string, next: Set<string>): void {
  const mod = info(file);
  for (const old of mod.imports) importers.get(old)?.delete(file);
  for (const dep of next) {
    let set = importers.get(dep);
    if (!set) importers.set(dep, (set = new Set()));
    set.add(file);
  }
  mod.imports = next;
}

/** The URL a file is served at, with `?import` for non-JS files imported from JS. */
function urlFor(file: string, asImport = false): string {
  const path = "/" + relative(root, file);
  const query = [asImport && !SOURCE.test(file) ? "import" : "", `t=${info(file).version}`].filter(Boolean).join("&");
  return `${path}?${query}`;
}

/** `./App` -> /abs/src/App.tsx, like the bundler would resolve it. */
function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith("/") ? join(root, spec) : resolve(dirname(from), spec);
  const candidates = [base].concat(
    EXTENSIONS.map((ext) => base + ext),
    EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  );
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

// ---------- transpiling ----------

const IMPORT = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*[\w$*{}\s,]+?\s*from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g;

async function transpile(file: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [file], external: ["*"], reactFastRefresh: true, target: "browser", format: "esm", define: DEFINE });
  let code = await result.outputs[0]!.text();
  // Bun prints `const App = _s(function App() {…}); var App = App;` for
  // `export default function App()` with hooks; the second declaration is a SyntaxError.
  code = code.replace(/^var ([\w$]+) = \1;\n/gm, (line, name) => (code.includes(`const ${name} = `) ? "" : line));
  const imports = new Set<string>();
  code = code.replace(IMPORT, (whole, head: string, quote: string, spec: string) => {
    if (!spec.startsWith(".") && !spec.startsWith("/")) return whole;
    const target = resolveLocal(spec, file);
    if (!target) return whole;
    imports.add(target);
    return `${head}${quote}${urlFor(target, true)}${quote}`;
  });
  setImports(file, imports);
  info(file).boundary = isBoundary(code);
  info(file).refreshIds = Array.from(code.matchAll(/\$RefreshReg\$\([\w$]+, ("[^"]*")\)/g), (m) => m[1]).join(",");
  return code;
}

/** Bun prints exports as one `export { a, b as default }` clause at the end. */
function isBoundary(code: string): boolean {
  const clause = /\nexport \{([^}]*)\};\s*$/.exec(code);
  if (!clause || /\nexport (?:const|let|var|function|class|default)\b/.test(code)) return false;
  const locals = clause[1]!.split(",").map((part) => part.trim().split(/\s+as\s+/)[0]!).filter(Boolean);
  // `export default App` prints as `var App_default = App;` and exports the alias.
  const registered = (name: string): boolean => {
    if (code.includes(`$RefreshReg$(${name},`)) return true;
    const alias = new RegExp(`\\nvar ${name.replace(/\$/g, "\\$")} = ([\\w$]+);\\n`).exec(code)?.[1];
    return alias !== undefined && alias !== name && registered(alias);
  };
  return locals.length > 0 && locals.every(registered);
}

interface BuildMessage {
  message: string;
  position?: { file: string; line: number; column: number; lineText: string } | null;
}

/** Bun's build errors as text: `file:line:column: message`, the line, and a caret. */
function buildError(err: unknown): string {
  const messages: BuildMessage[] = err instanceof AggregateError && err.errors.length ? err.errors : [{ message: String(err instanceof Error ? err.message : err) }];
  const text = messages
    .map(({ message, position: at }) => {
      if (!at) return message;
      const file = relative(root, at.file);
      return `${file}:${at.line}:${at.column}: ${message}\n\n  ${at.lineText}\n  ${" ".repeat(Math.max(0, at.column))}^`;
    })
    .join("\n\n");
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/^Bundle failed\n/, "").trim();
}

// ---------- HMR events ----------

type HmrEvent =
  | { type: "update"; modules: string[] }
  | { type: "css"; url: string }
  | { type: "reload" }
  | { type: "errors" };

let lastId = 0;
const events: { id: number; event: HmrEvent }[] = [];
const waiting = new Set<() => void>();

function emit(event: HmrEvent): void {
  events.push({ id: ++lastId, event });
  if (events.length > 100) events.shift();
  for (const wake of waiting) wake();
  waiting.clear();
}

function errorList(): { file: string; message: string }[] {
  return Array.from(errors, ([file, message]) => ({ file: relative(root, file), message }));
}

async function poll(since: number): Promise<Response> {
  if (since >= 0 && !events.some((e) => e.id > since)) {
    await new Promise<void>((wake) => {
      waiting.add(wake);
      setTimeout(() => {
        waiting.delete(wake);
        wake();
      }, 20_000);
    });
  }
  const pending = since < 0 ? [] : events.filter((e) => e.id > since).map((e) => e.event);
  return Response.json({ id: lastId, events: pending, errors: errorList() }, { headers: { "cache-control": "no-store" } });
}

/** Writes an edited file and tells the browser what to update. */
async function update(path: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const file = resolve(root, path.replace(/^\/+/, ""));
  if (relative(root, file).startsWith("..")) return { ok: false, error: `${path} is outside the project` };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const name = relative(root, file);
  if (file.endsWith(".css")) {
    info(file).version++;
    console.log(`\x1b[32m[hmr]\x1b[0m css ${name}`);
    emit({ type: "css", url: urlFor(file, true) });
    return { ok: true };
  }
  if (!SOURCE.test(file)) {
    console.log(`\x1b[32m[hmr]\x1b[0m reload (${name})`);
    emit({ type: "reload" });
    return { ok: true };
  }
  const before = info(file).refreshIds;
  try {
    await transpile(file);
  } catch (err) {
    const message = buildError(err);
    errors.set(file, message);
    console.log(`\x1b[31m[hmr] ${name}: build failed\x1b[0m\n${message}`);
    emit({ type: "errors" });
    return { ok: false, error: message };
  }
  errors.delete(file);
  // Not loaded by the page yet: nothing to update.
  if (!importers.has(file) && file !== entry()) {
    emit({ type: "errors" });
    return { ok: true };
  }
  const boundaries = new Set<string>();
  let reload = false;
  const seen = new Set<string>();
  const walk = (mod: string) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    info(mod).version++;
    if (info(mod).boundary) {
      boundaries.add(mod);
      return;
    }
    const parents = importers.get(mod);
    if (!parents || parents.size === 0) reload = true;
    else for (const parent of parents) walk(parent);
  };
  walk(file);
  // Components registered under new ids (`function App` became `export default function App`)
  // are new to React: it would keep showing the old ones.
  if (boundaries.has(file) && before !== "" && info(file).refreshIds !== before) reload = true;
  if (reload) {
    console.log(`\x1b[32m[hmr]\x1b[0m reload (${name})`);
    emit({ type: "reload" });
  } else {
    console.log(`\x1b[32m[hmr]\x1b[0m update ${Array.from(boundaries, (b) => relative(root, b)).join(", ")}`);
    emit({ type: "update", modules: Array.from(boundaries, (b) => urlFor(b)) });
  }
  return { ok: true };
}

/** The script index.html loads, e.g. /abs/src/main.tsx. */
function entry(): string | null {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const src = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
  return src ? resolveLocal(src, join(root, "index.html")) : null;
}

// ---------- serving ----------

function html(): Response {
  const page = readFileSync(join(root, "index.html"), "utf8");
  const head = [
    `<script type="importmap">${JSON.stringify({ imports: importMap })}</script>`,
    `<script type="module" src="/@hmr/client.js"></script>`,
  ].join("\n    ");
  const body = page.includes("<head>") ? page.replace("<head>", `<head>\n    ${head}`) : head + page;
  return new Response(body, { headers: { "content-type": TYPES[".html"]!, "cache-control": "no-store", ...ISOLATION } });
}

function js(code: string): Response {
  return new Response(code, { headers: { "content-type": TYPES[".js"]!, "cache-control": "no-store" } });
}

/** A module that shows a build error in the overlay (the page reloads once it is fixed). */
function failingModule(file: string, message: string): Response {
  return js(`import { showErrors } from "/@hmr/client.js";\nshowErrors(${JSON.stringify([{ file: relative(root, file), message }])}, true);\n`);
}

async function serveFile(file: string, asImport: boolean): Promise<Response> {
  const ext = extname(file);
  if (SOURCE.test(file)) {
    try {
      const code = await transpile(file);
      errors.delete(file);
      return js(code);
    } catch (err) {
      const message = buildError(err);
      errors.set(file, message);
      console.log(`\x1b[31m${relative(root, file)}: build failed\x1b[0m\n${message}`);
      return failingModule(file, message);
    }
  }
  if (asImport && ext === ".css") {
    const id = "/" + relative(root, file);
    const css = readFileSync(file, "utf8");
    return js(`import { updateStyle } from "/@hmr/client.js";\nupdateStyle(${JSON.stringify(id)}, ${JSON.stringify(css)});\n`);
  }
  if (asImport && ext === ".json") return js(`export default ${readFileSync(file, "utf8")};\n`);
  if (asImport) return js(`export default ${JSON.stringify("/" + relative(root, file))};\n`);
  return new Response(Bun.file(file), { headers: { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
}

await bundleDeps();

startup("starting-server");
const server = Bun.serve({
  port,
  hostname: process.env.HOST || "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "/index.html") return html();
    if (path === "/@hmr/deps") return Response.json({ deps: Object.fromEntries(deps), importMap });
    if (path === "/@hmr/client.js") return js(readFileSync(join(import.meta.dir, "hmr-client.js"), "utf8"));
    if (path === "/@hmr/events") return poll(Number(url.searchParams.get("since") ?? -1));
    if (path === "/@hmr/update" && req.method === "POST") {
      const body = (await req.json()) as { path: string; text: string };
      return Response.json(await update(body.path, body.text));
    }
    if (path.startsWith("/@deps/")) {
      const code = deps.get(path.slice("/@deps/".length));
      return code === undefined ? new Response("not found", { status: 404 }) : js(code);
    }
    const file = join(root, path);
    if (relative(root, file).startsWith("..") || !existsSync(file) || !statSync(file).isFile()) {
      return new Response(`${path} not found`, { status: 404, headers: { "content-type": TYPES[".txt"]! } });
    }
    return serveFile(file, url.searchParams.has("import"));
  },
});

console.log(`\n  \x1b[1;35mbun dev\x1b[0m  ready\n\n  ➜  Local:   \x1b[36m${server.url}\x1b[0m\n`);
