// Bun.build as a Bun author tries it first: minify, splitting, define, external, sourcemaps,
// HTML entries and the CLI (docs/bun-api-probe.md). Each check prints one line. Plugins are not
// supported yet and are left out.

async function check(name: string, body: () => unknown): Promise<void> {
  try {
    const value = await body();
    console.log(`ok ${name}${value === undefined ? "" : ": " + (typeof value === "string" ? value : Bun.inspect(value))}`);
  } catch (error) {
    const details = error instanceof AggregateError ? error.errors.map(String).join("; ") : "";
    console.log(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}${details ? ` (${details})` : ""}`);
  }
}

await Bun.write("src/index.tsx", `/** @jsxRuntime classic */
/** @jsx h */
import { greet } from "./greet";
import data from "./data.json";
import config from "./config";
const h = (tag: string, _props: unknown, ...children: unknown[]) => \`<\${tag}>\${children.join("")}</\${tag}>\`;
const App = () => <div>{greet(data.name)}</div>;
console.log(App(), config.mode, process.env.NODE_ENV);
export const lazy = () => import("./lazy");
`);
await Bun.write("src/greet.ts", `export function greet(name: string): string { return "hello " + name; }\n`);
await Bun.write("src/lazy.ts", `import { greet } from "./greet"; export default greet("lazy");\n`);
await Bun.write("src/data.json", `{ "name": "bun" }\n`);
await Bun.write("src/config.ts", `export default { mode: "config" };\n`);

const summary = (result: Bun.BuildOutput) => [result.success, result.outputs.map(output => `${output.kind}:${output.path.split("/").pop()?.replace(/-[a-z0-9]+\./, "-HASH.")}`).sort()];

await check("Bun.build basic", async () => {
  const result = await Bun.build({ entrypoints: ["./src/index.tsx"], define: { "process.env.NODE_ENV": '"production"' } });
  const text = await result.outputs[0].text();
  return [result.success, result.outputs.length, text.includes("hello "), text.includes("config")];
});
await check("Bun.build minify", async () => {
  const result = await Bun.build({ entrypoints: ["./src/greet.ts"], minify: true });
  return (await result.outputs[0].text()).trim();
});
await check("Bun.build splitting outdir", async () => {
  const result = await Bun.build({ entrypoints: ["./src/index.tsx"], outdir: "./dist", splitting: true, naming: "[name]-[hash].[ext]" });
  return summary(result);
});
await check("run built output", async () => {
  const result = await Bun.build({ entrypoints: ["./src/index.tsx"], outdir: "./dist-run", target: "bun", define: { "process.env.NODE_ENV": '"built"' } });
  const child = Bun.spawnSync([process.execPath, result.outputs[0].path]);
  return child.stdout.toString().trim() || child.stderr.toString().trim();
});
await check("Bun.build sourcemap + target node", async () => {
  const result = await Bun.build({ entrypoints: ["./src/greet.ts"], target: "node", sourcemap: "linked", outdir: "./dist-map" });
  return summary(result);
});
await check("Bun.build external + format cjs", async () => {
  await Bun.write("src/uses-ext.ts", `import x from "left-pad"; export default x;\n`);
  const result = await Bun.build({ entrypoints: ["./src/uses-ext.ts"], external: ["left-pad"], format: "cjs" });
  return (await result.outputs[0].text()).includes(`require("left-pad")`);
});
await check("Bun.build error", async () => {
  await Bun.write("src/broken.ts", `import "./does-not-exist";\n`);
  try {
    const result = await Bun.build({ entrypoints: ["./src/broken.ts"], throw: false });
    return [result.success, result.logs.length > 0, String(result.logs[0]?.message ?? "").includes("does-not-exist")];
  } catch (error) {
    return ["threw", String((error as Error).message).includes("does-not-exist")];
  }
});
await check("Bun.build css + html", async () => {
  await Bun.write("web/index.html", `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./main.ts"></script></body></html>`);
  await Bun.write("web/style.css", `body { color: red; }\n`);
  await Bun.write("web/main.ts", `document.body.append("hi");\n`);
  const result = await Bun.build({ entrypoints: ["./web/index.html"], outdir: "./dist-web" });
  return summary(result);
});
await check("bun build CLI --minify", () => {
  const child = Bun.spawnSync([process.execPath, "build", "./src/greet.ts", "--minify"]);
  return child.stdout.toString().trim() || child.stderr.toString().trim();
});
await check("bun build CLI --outdir --splitting", () => {
  const child = Bun.spawnSync([process.execPath, "build", "./src/lazy.ts", "./src/greet.ts", "--outdir", "./dist-cli", "--splitting"]);
  return [child.exitCode, Array.from(new Bun.Glob("*.js").scanSync("dist-cli"), name => name.replace(/-[a-z0-9]{8}\./, "-HASH.")).sort()];
});
