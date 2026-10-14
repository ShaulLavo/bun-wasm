// Seed programs for the playground's home directory.

export const HOME = "/home/user";

export const examples: Record<string, string> = {
  "index.ts": `// Hello from Bun, compiled to WebAssembly and running in your browser.
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

  "files.ts": `// Bun.write and Bun.file against the in-memory filesystem.
// Files you write here show up in the editor and in \`ls\`.
const path = "notes/hello.txt";

await Bun.write(path, "Written by Bun.write at " + new Date().toISOString() + "\\n");
const file = Bun.file(path);
console.log("exists:", await file.exists());
console.log("size:", file.size, "bytes");
console.log("text:", (await file.text()).trim());

await Bun.write("notes/data.json", JSON.stringify({ language: "TypeScript", runtime: "bun.wasm" }, null, 2));
const data = await Bun.file("notes/data.json").json();
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
// JSX compiled by Bun's transpiler into calls to our own tiny h() that renders to a string.
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
};
