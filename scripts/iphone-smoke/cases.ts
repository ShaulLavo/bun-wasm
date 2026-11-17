import type { Box } from "../goals-matrix/catalog";

export const smokeCases: readonly Box[] = [
  { framework: "vite-react", browser: "iphone-safari", engine: "browser" },
  { framework: "hono", browser: "iphone-safari", engine: "browser" },
  { framework: "vite-react", browser: "iphone-safari", engine: "quickjs" },
];
export const smokePhases = ["startup", "install", "dev", "render", "click", "cleanup"] as const;
