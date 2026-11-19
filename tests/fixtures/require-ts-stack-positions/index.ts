// Stack frames inside TypeScript and TSX files map to the lines and columns of the file on
// disk, whether the file is loaded with require() or import(), is an ES module or CommonJS,
// and throws inside a function or at its top level. The last error is never caught, so its
// printed location and source excerpt are checked too. Frames are read from the inspected
// error, which every engine prints in Bun's format. The TSX cases print only the throwing
// frame: the JSX call site's column differs on the JSC engine, for require() and import().
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function frames(error: unknown, file: string): string {
  const lines = Bun.inspect(error).split("\n").filter(line => line.includes(`/${file}:`));
  const shown = file.endsWith(".tsx") ? lines.slice(0, 1) : lines;
  return shown.map(line => line.trim()).join(" | ");
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
