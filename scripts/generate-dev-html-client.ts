import { writeFileSync } from "node:fs";

export async function generateDevelopmentHtmlClient(source: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [source], target: "browser", format: "iife", minify: true });
  if (!result.success || result.outputs.length !== 1) throw new AggregateError(result.logs, "Cannot generate development HTML client");
  return `(function () { "use strict"; return { source: ${JSON.stringify(await result.outputs[0]!.text())} }; })\n`;
}

if (import.meta.main) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error("Usage: bun generate-dev-html-client.ts <source.ts> <output.js>");
  writeFileSync(destination, await generateDevelopmentHtmlClient(source));
}
