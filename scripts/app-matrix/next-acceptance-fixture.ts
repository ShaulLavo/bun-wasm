import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function fixtureSources(directory: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", ".gitignore", "next-env.d.ts"].includes(entry.name) || entry.name.endsWith("tsbuildinfo")) continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, fixtureSources(join(directory, entry.name), path + "/"));
    else files[path] = readFileSync(join(directory, entry.name), "utf8");
  }
  return files;
}

export function stageFixture(source: Record<string, string>) {
  const typescript = source["next.config.ts"];
  if (!typescript) throw new Error("Missing authoritative next.config.ts");
  const generated = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(typescript);
  const files = { ...source };
  delete files["next.config.ts"];
  files["next.config.mjs"] = generated;
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    files,
    config: {
      sourcePath: "next.config.ts", sourceSha256: sha256(typescript),
      generatedPath: "next.config.mjs", generatedSha256: sha256(generated),
      generator: `Bun ${Bun.version} Transpiler(loader=ts,target=browser).transformSync`,
      settings: "outputFileTracingRoot=process.cwd(); agentRules=false; experimental.cpus=1",
    },
  };
}
