import type { Fixture } from "./model";

export function projectFiles(fixture: Fixture, registry: string): Record<string, string> & { "package.json": string; "bunfig.toml": string } {
  return {
    ...fixture.files,
    "package.json": JSON.stringify({ name: `shell-product-${fixture.id}`, private: true, type: "module", dependencies: fixture.dependencies, scripts: fixture.scripts }),
    "bunfig.toml": `[install]\nregistry = ${JSON.stringify(registry)}\n`,
  };
}
