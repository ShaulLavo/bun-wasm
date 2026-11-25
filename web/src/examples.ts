// Seed programs for the playground's home directory.

export const HOME = "/home/user";

export const examples: Record<string, string> = {
  "index.ts": `// Bun compiles and runs this TypeScript in your browser tab.
interface Greeting {
  name: string;
  excited?: boolean;
}

function greet({ name, excited = false }: Greeting): string {
  return \`Hello, \${name}\${excited ? "!" : "."}\`;
}

const names: string[] = ["world", "Bun", "WebAssembly"];
for (const name of names) {
  console.log(greet({ name, excited: name === "Bun" }));
}

console.log("Bun version:", Bun.version);
console.log("argv:", process.argv.slice(2));
console.log("cwd:", process.cwd());
`,

  "files.ts": `// Bun.write and Bun.file on the browser filesystem.
// Written files appear in the editor and in \`ls\`.
const path = \`\${import.meta.dir}/notes/hello.txt\`;

await Bun.write(path, "Written by Bun.write at " + new Date().toISOString() + "\\n");
const file = Bun.file(path);
console.log("exists:", await file.exists());
console.log("size:", file.size, "bytes");
console.log("text:", (await file.text()).trim());

const json = \`\${import.meta.dir}/notes/data.json\`;
await Bun.write(json, JSON.stringify({ language: "TypeScript", runtime: "bun.wasm" }, null, 2));
const data = await Bun.file(json).json();
console.log("json:", data);
`,

  "node-fs.ts": `// node:fs and node:path work too.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

const dir = join(process.cwd(), "out");
mkdirSync(dir, { recursive: true });

for (const n of [1, 2, 3]) {
  writeFileSync(join(dir, \`file-\${n}.txt\`), \`line \${n}\\n\`.repeat(n));
}

for (const name of readdirSync(dir).sort()) {
  const full = join(dir, name);
  const lines = readFileSync(full, "utf8").trimEnd().split("\\n").length;
  console.log(relative(process.cwd(), full), basename(name, extname(name)), statSync(full).size + "B", lines, "lines");
}
`,

  "timers.ts": `// Async functions, timers and Bun.sleep.
const start = performance.now();
const elapsed = () => \`\${Math.round(performance.now() - start)}ms\`;

async function task(name: string, ms: number): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  console.log(\`  \${name} finished after \${elapsed()}\`);
  return name;
}

console.log("starting three tasks in parallel…");
const done = await Promise.all([task("slow", 600), task("fast", 200), task("medium", 400)]);
console.log("all done:", done.join(", "), "at", elapsed());

let ticks = 0;
await new Promise<void>((resolve) => {
  const id = setInterval(() => {
    ticks++;
    console.log(\`tick \${ticks}\`);
    if (ticks === 3) {
      clearInterval(id);
      resolve();
    }
  }, 250);
});

await Bun.sleep(300);
console.log("slept with Bun.sleep, total", elapsed());
`,

  "jsx.tsx": `/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// Bun's transpiler compiles this JSX to h() calls that render HTML strings.
type Child = string | number | boolean | null | undefined | Child[];
type Props = Record<string, unknown> & { children?: Child[] };

function h(tag: string | ((props: Props) => string), props: Record<string, unknown> | null, ...children: Child[]): string {
  if (typeof tag === "function") return tag({ ...props, children });
  const attrs = Object.entries(props ?? {})
    .map(([key, value]) => \` \${key === "className" ? "class" : key}="\${String(value)}"\`)
    .join("");
  return \`<\${tag}\${attrs}>\${render(children)}</\${tag}>\`;
}

function Fragment(props: Props): string {
  return render(props.children ?? []);
}

function render(children: Child[]): string {
  return children.flat(Infinity as 1).filter((c) => c !== null && c !== undefined && c !== false && c !== true).join("");
}

function Item({ label, done }: { label: string; done: boolean }) {
  return <li className={done ? "done" : "todo"}>{done ? "✓" : "○"} {label}</li>;
}

const todos = [
  { label: "compile Bun to wasm32-wasip1", done: true },
  { label: "run it in a browser", done: true },
  { label: "ship it", done: false },
];

const html = (
  <>
    <h1>Todo</h1>
    <ul>
      {todos.map((t) => (
        <Item label={t.label} done={t.done} />
      ))}
    </ul>
  </>
);

console.log(html);
`,

  "math.ts": `// Imported by math.test.ts and build.ts. Try: bun build math.ts --outdir out --minify
export function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

if (import.meta.main) console.log("fib(20) =", fib(20), "mean =", mean([1, 2, 3, 4]));
`,

  "math.test.ts": `// Bun's test runner in WebAssembly. Press Run or run: bun test
import { describe, expect, test, mock } from "bun:test";
import { fib, mean } from "./math";

describe("fib", () => {
  test("small numbers", () => {
    expect([0, 1, 2, 3, 4, 5].map(fib)).toEqual([0, 1, 1, 2, 3, 5]);
  });
  test.each([[10, 55], [20, 6765]])("fib(%i) = %i", (n, want) => {
    expect(fib(n)).toBe(want);
  });
});

test("mean", () => {
  expect(mean([1, 2, 3, 4])).toBeCloseTo(2.5);
});

test("mocks and async", async () => {
  const fetchUser = mock(async (id: number) => ({ id, name: "user" + id }));
  await expect(fetchUser(7)).resolves.toMatchObject({ name: "user7" });
  expect(fetchUser).toHaveBeenCalledWith(7);
});
`,

  "serve.ts": `// HTTP server in this tab with routes and a bun:sqlite visit counter.
// Edit the HTML or a route, then press Restart above the preview.
import { Database } from "bun:sqlite";

// One in-memory database per server, so tabs never write to the same SQLite file.
const db = new Database(":memory:");
db.run("CREATE TABLE IF NOT EXISTS visits (at TEXT NOT NULL)");

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": () => {
      db.run("INSERT INTO visits (at) VALUES (?)", [new Date().toISOString()]);
      const { visits } = db.query("SELECT count(*) AS visits FROM visits").get() as { visits: number };
      return new Response(page(visits), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    "/api/hello/:name": (request) => Response.json({ hello: request.params.name, bun: Bun.version, at: new Date().toISOString() }),
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

console.log(\`Bun.serve is listening on \${server.url}\`);
const response = await fetch(new URL("/api/hello/terminal", server.url));
console.log("GET /api/hello/terminal ->", response.status, await response.json());

function page(visits: number): string {
  return \`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bun.serve in WebAssembly</title>
<style>
  html { color-scheme: dark; background: #14151a; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; color: #e6e6e6; font: 15px/1.5 system-ui, sans-serif; }
  main { margin: auto; max-width: 32rem; padding: 1.25rem; text-align: center; }
  h1 { color: #fbf0df; margin: 0 0 .5rem; font-size: clamp(1.35rem, 5vw, 2rem); line-height: 1.15; }
  b { color: #f472b6; }
  button { font: inherit; border: 0; border-radius: 6px; padding: .5rem 1rem; background: #fbf0df; color: #14151a; cursor: pointer; }
  pre { text-align: left; background: #1b1d24; border: 1px solid #2a2d38; border-radius: 6px; padding: .6rem .75rem; margin: .75rem 0 0; font-size: 13px; white-space: pre-wrap; }
</style>
<main>
  <h1>Hello from Bun.serve</h1>
  <p>Bun \${Bun.version}, compiled to WebAssembly, served this page from inside your browser tab.</p>
  <p>bun:sqlite has counted <b>\${visits}</b> visit\${visits === 1 ? "" : "s"}. Reload to add one.</p>
  <button id="hello">GET /api/hello/browser</button>
  <pre id="out">Click the button to call a route.</pre>
</main>
<script>
  document.getElementById("hello").onclick = async () => {
    const response = await fetch("api/hello/browser");
    document.getElementById("out").textContent = JSON.stringify(await response.json(), null, 2);
  };
</script>\`;
}
`,

  "shell.ts": `// Bun's shell runs globs, pipes, and builtins on this workspace's filesystem.
import { $ } from "bun";

console.log("glob:", (await $\`echo *.ts\`.cwd(import.meta.dir).text()).trim());

// Bun.$ escapes interpolated values, so this stays one argument.
const risky = "hello; rm -rf /";
console.log("escaped:", (await $\`echo \${risky}\`.text()).trim());

// Pipe between commands, or parse stdout as JSON.
console.log("words:", (await $\`echo Bun in WebAssembly | wc -w\`.text()).trim());
const data = await $\`echo '{"runtime":"bun.wasm","files":3}'\`.json();
console.log("json:", data);

// Failing commands throw unless you chain .nothrow().
const { exitCode } = await $\`ls does-not-exist\`.nothrow().quiet();
console.log("exit code of a failed ls:", exitCode);
`,

  "build.ts": `// Bundle and minify jsx.tsx and math.ts into dist/ with linked sourcemaps.
const here = import.meta.dir;
const result = await Bun.build({
  entrypoints: [\`\${here}/jsx.tsx\`, \`\${here}/math.ts\`],
  outdir: \`\${here}/dist\`,
  minify: true,
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(\`\${output.kind.padEnd(10)} \${output.path.slice(here.length + 1).padEnd(18)} \${output.size} bytes\`);
}

const math = result.outputs.find((output) => output.path.endsWith("math.js"));
if (math) console.log("\\nminified math.js:\\n" + (await math.text()).split("\\n")[0]);
`,

  "db.ts": `// In-memory SQLite in WebAssembly, so open tabs never share a database file.
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.run("CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT, done INTEGER)");

const insert = db.prepare("INSERT INTO todos (title, done) VALUES ($title, $done)");
const addMany = db.transaction((rows: { title: string; done: boolean }[]) => {
  for (const row of rows) insert.run({ $title: row.title, $done: row.done ? 1 : 0 });
});
addMany([
  { title: "compile Bun to wasm", done: true },
  { title: "run bun:sqlite in a browser", done: true },
  { title: "ship it", done: false },
]);

console.table(db.query("SELECT id, title, done FROM todos ORDER BY id").all());
const { open } = db.query("SELECT count(*) AS open FROM todos WHERE done = 0").get() as { open: number };
console.log(open, "open todo(s)");
`,
};
