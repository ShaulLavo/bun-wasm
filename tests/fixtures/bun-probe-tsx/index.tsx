/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// TypeScript and JSX out of the box (docs/bun-api-probe.md). Each check prints one line.
type Node = { tag: string | typeof Fragment; props: Record<string, unknown> | null; children: unknown[] };
const Fragment = Symbol("Fragment");
function h(tag: string | typeof Fragment | ((props: Record<string, unknown>) => Node), props: Record<string, unknown> | null, ...children: unknown[]): Node {
  if (typeof tag === "function") return tag({ ...props, children });
  return { tag, props, children };
}
function render(node: unknown): string {
  if (Array.isArray(node)) return node.map(render).join("");
  if (typeof node !== "object" || node === null) return String(node);
  const { tag, props, children } = node as Node;
  const inner = children.map(render).join("");
  if (tag === Fragment) return inner;
  const attrs = Object.entries(props ?? {}).map(([key, value]) => ` ${key}="${value}"`).join("");
  return `<${String(tag)}${attrs}>${inner}</${String(tag)}>`;
}

async function check(name: string, body: () => unknown): Promise<void> {
  try {
    const value = await body();
    console.log(`ok ${name}${value === undefined ? "" : ": " + (typeof value === "string" ? value : Bun.inspect(value))}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

enum Color { Red = "red", Green = "green" }
const enum Size { Small = 1, Large = 10 }
namespace Shapes {
  export const sides = (name: "square" | "triangle") => (name === "square" ? 4 : 3);
}
interface Point { x: number; y: number }
abstract class Base<T> {
  constructor(protected readonly value: T) {}
  abstract describe(): string;
}
class Box<T extends object> extends Base<T> {
  #secret = 42;
  static count = 0;
  describe(): string { return `box of ${Object.keys(this.value).join(",")} (${this.#secret})`; }
}
function logged(_target: unknown, context: ClassMethodDecoratorContext) {
  return function (this: unknown, ...args: unknown[]) { return `decorated ${String(context.name)}: ${(_target as (...a: unknown[]) => unknown).apply(this, args)}`; };
}
class Service {
  @logged hello(name: string) { return `hi ${name}`; }
}
const Card = ({ title, children }: { title: string; children?: unknown }) => <section class="card"><h2>{title}</h2>{children}</section>;

await check("enum + const enum", () => [Color.Green, Size.Large, Object.keys(Color)]);
await check("namespace", () => Shapes.sides("square"));
await check("generics + abstract + private field", () => new Box<Point>({ x: 1, y: 2 }).describe());
await check("satisfies + as const", () => {
  const config = { port: 3000, tags: ["a"] } as const satisfies { port: number; tags: readonly string[] };
  return config.port;
});
await check("type-only imports", async () => {
  await Bun.write("types.ts", `export type T = { a: number }; export interface I { b: string } export const real = "real";\n`);
  const mod = await import("./types.ts");
  return Object.keys(mod);
});
await check("decorators", () => new Service().hello("bun"));
await check("optional chaining + nullish + bigint", () => [({} as { a?: { b?: number } }).a?.b ?? "none", 2n ** 64n]);
await check("using + Symbol.dispose", () => {
  const log: string[] = [];
  {
    using _resource = { [Symbol.dispose]: () => log.push("disposed") };
    log.push("inside");
  }
  return log;
});
await check("jsx pragma", () => render(<Card title="Hello"><p id="x">from {"jsx"}</p><>frag</></Card>));
await check("import .tsx component", async () => {
  await Bun.write("component.tsx", `/** @jsxRuntime classic */\n/** @jsx h */\nconst h = (tag: string, _p: unknown, ...c: unknown[]) => tag + ":" + c.join("");\nexport default <b>bold</b>;\n`);
  return (await import("./component.tsx")).default;
});
await check("import json + text", async () => {
  await Bun.write("data.json", `{ "ok": true }`);
  await Bun.write("note.txt", "plain text");
  const json = await import("./data.json");
  const text = await import("./note.txt", { with: { type: "text" } });
  return [json.default.ok, text.default];
});
await check("top-level await", () => "reached");
await check("require + import interop", async () => {
  await Bun.write("cjs.cjs", `module.exports = { kind: "cjs" };\n`);
  const required = require("./cjs.cjs");
  const imported = await import("./cjs.cjs");
  return [required.kind, imported.default.kind];
});
await check("error stack has .tsx line", () => {
  const stack = new Error("where").stack ?? "";
  return /index\.tsx:\d+/.test(stack);
});
