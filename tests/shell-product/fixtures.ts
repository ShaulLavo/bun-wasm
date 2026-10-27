import { viteApps } from "../../scripts/app-matrix/product-vite";
import { nextApps } from "../../scripts/app-matrix/product-next";
import type { ProductApp } from "../../scripts/app-matrix/product-types";
import type { Fixture } from "./model";

function fixture(apps: readonly ProductApp[], id: string) {
  const app = apps.find(candidate => candidate.id === id);
  if (!app) throw new Error(`Missing original product fixture ${id}`);
  const dev = app.commands.find(command => command.name === "dev");
  if (dev?.check.kind !== "page") throw new Error(`Missing page contract for ${id}`);
  const executable = id === "vite-react" ? "vite --host 127.0.0.1 --strictPort --port ${PORT:-3137}" : "next dev --hostname 127.0.0.1 --port ${PORT:-3137}";
  const build = id === "vite-react" ? "vite build" : "next build";
  return { id, files: app.files, dependencies: app.dependencies, selector: dev.check.selector, text: dev.check.text, tool: id === "vite-react" ? "vite" : "next", buildOutputs: buildOutputs(app), scripts: { dev: executable, build } };
}

function buildOutputs(app: ProductApp) {
  const command = app.commands.find(candidate => candidate.name === "build");
  if (command?.check.kind !== "files") throw new Error(`Missing build files for ${app.id}`);
  return command.check.paths;
}

const viteFixture = fixture(viteApps, "vite-react");
const nextFixture = fixture(nextApps, "next-15-app");
export const fixtures = [viteFixture, nextFixture];
export type { Fixture };
export const stages = ["install", "install-and-dev-dom", "ctrl-c-1", "restart-2-dom", "ctrl-c-2", "restart-3-dom", "ctrl-c-3", "build-tail", "bun-x-grep", "redirect", "and-or-status", "cwd", "port-3001-dom", "ctrl-c-port"] as const;
export type Stage = (typeof stages)[number];
export type Row = { app: string; stage: Stage | "setup" | "session" | "network" | "cleanup"; status: "pass" | "fail" | "blocked"; detail: string };

export type ProductRun = { mode: "full" | "next-install-only" | "vite-dev-ctrl-c" | "next-dev-ctrl-c"; fixtures: readonly Fixture[]; stages: readonly Stage[] };

const devStages: readonly Stage[] = ["install", "install-and-dev-dom", "ctrl-c-1"];

export function selectProductRun(value = "full"): ProductRun {
  if (value === "full") return { mode: value, fixtures, stages };
  if (value === "next-install-only") return { mode: value, fixtures: [nextFixture], stages: ["install"] };
  if (value === "vite-dev-ctrl-c") return { mode: value, fixtures: [viteFixture], stages: devStages };
  if (value === "next-dev-ctrl-c") return { mode: value, fixtures: [nextFixture], stages: devStages };
  throw new Error(`Invalid SHELL_PRODUCT_RUN ${JSON.stringify(value)}; expected full, next-install-only, vite-dev-ctrl-c or next-dev-ctrl-c`);
}
