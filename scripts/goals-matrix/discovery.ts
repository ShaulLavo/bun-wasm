import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectTemplates } from "../../web/src/playground/project-templates";
import type { Box } from "./catalog";
import { ENGINES, isEngine } from "../../web/src/engine-loader";
import { engineFiles } from "./engines";
export function prerequisites(box: Box, options: { root: string; safariEndpoint?: string; iphoneEndpoint?: string }): { reason: string; discovery: unknown } | undefined {
  const template = projectTemplates.find(template => template.id === box.framework);
  if (!template || !existsSync(join(options.root, template.file))) return { reason: `Missing built playground template ${box.framework}`, discovery: { catalog: template ?? null, root: options.root } };
  if (!isEngine(box.engine)) return {
    reason: `${box.engine} is not registered in the public playground Engine union or engine loader`,
    discovery: { sources: ["src/engine-kind.ts", "web/src/engine-loader.ts"], registered: Object.keys(ENGINES) },
  };
  const required = engineFiles(box.engine).map(name => name + ".gz");
  const missing = required.filter(name => !existsSync(join(options.root, name)) && !existsSync(join(options.root, name.replace(/\.gz$/, ""))));
  if (missing.length) return { reason: `Missing engine assets: ${missing.join(", ")}`, discovery: { root: options.root, checked: required } };
  if (box.browser === "safari" && !options.safariEndpoint) return { reason: "Native Safari needs a discovered Mac WebDriver endpoint; no endpoint configured", discovery: { platform: process.platform, configuredEndpoint: null } };
  if (box.browser === "iphone-safari" && !options.iphoneEndpoint) return { reason: "Native iPhone Safari needs a discovered simulator WebDriver endpoint; no endpoint configured", discovery: { platform: process.platform, configuredEndpoint: null } };
  return undefined;
}
