// Stack frames inside TypeScript and TSX files map to the lines and columns of the file on
// disk, whether the file is loaded with require() or import(), is an ES module or CommonJS,
// and throws inside a function or at its top level. The last error is never caught, so its
// printed location and source excerpt are checked too.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function frames(error: unknown, file: string): string {
  const lines = String((error as Error).stack).split("\n");
  return lines.filter(line => line.includes(`/${file}:`)).map(line => line.trim()).join(" | ");
}

function report(label: string, file: string, run: () => unknown): void {
  try {
    run();
    console.log(`${label}: no error`);
  } catch (error) {
    console.log(`${label}: ${frames(error, file)}`);
  }
}

async function reportAsync(label: string, file: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(`${label}: no error`);
  } catch (error) {
    console.log(`${label}: ${frames(error, file)}`);
  }
}

report("require ESM .ts", "required.ts", () => require("./required.ts").area({ kind: "square", size: -2 }));
report("require ESM .tsx", "required.tsx", () => require("./required.tsx").render("x"));
report("require CommonJS .ts", "required-cjs.ts", () => require("./required-cjs.ts").parse("x", { strict: true }));
report("require CommonJS .cjs", "required-plain.cjs", () => require("./required-plain.cjs").parse("x"));
report("require throws at top level", "top-level.ts", () => require("./top-level.ts"));
report("require ESM .ts again", "required.ts", () => require("./required.ts").area({ kind: "circle", size: -3 }));
await reportAsync("import .ts", "imported.ts", async () => (await import("./imported.ts")).area({ kind: "square", size: -2 }));
await reportAsync("import .tsx", "imported.tsx", async () => (await import("./imported.tsx")).render("x"));

require("./uncaught.ts").listen({ port: 70000 });
