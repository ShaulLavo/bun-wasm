export const engines = ["browser", "quickjs", "jsc", "spidermonkey"] as const;
export const browsers = ["chrome", "firefox", "safari", "iphone-safari"] as const;
export type Engine = typeof engines[number];
export type Browser = typeof browsers[number];
export const browserLabels: Record<Browser, string> = {
  chrome: "Chrome", firefox: "Firefox", safari: "Desktop Safari (native)", "iphone-safari": "iPhone Safari (native simulator)",
};
export interface Framework {
  id: string;
  label: string;
  template: string;
  source: string;
  selector: string;
  text: string;
  button: string;
  clicked: string;
}
function starter(id: string, label: string, source: string): Framework {
  return { id, label, template: id, source, selector: "#message", text: `Hello from ${id}`, button: "#increment", clicked: "#count" };
}
export const frameworks: readonly Framework[] = [
  { id: "next", label: "Next.js", template: "next", source: "pages/index.tsx", selector: "h1", text: "Next.js in your browser", button: "button", clicked: "button" },
  starter("nuxt", "Nuxt", "app.vue"),
  starter("sveltekit", "SvelteKit", "src/routes/+page.svelte"),
  starter("astro", "Astro", "src/pages/index.astro"),
  starter("react-router", "React Router / Remix", "app/routes/home.tsx"),
  starter("solidstart", "SolidStart", "src/routes/index.tsx"),
  starter("tanstack-start", "TanStack Start", "src/routes/index.tsx"),
  starter("angular", "Angular", "src/main.ts"),
  starter("qwik", "Qwik", "src/routes/index.tsx"),
  { id: "vite-react", label: "Vite React", template: "vite-react", source: "src/App.tsx", selector: "h1", text: "Hello from bun.wasm", button: "button.counter", clicked: "button.counter" },
  starter("vite-vue", "Vite Vue", "src/App.vue"),
  starter("vite-svelte", "Vite Svelte", "src/App.svelte"),
  starter("hono", "Hono", "src/page.html"),
];
export interface Box { framework: string; browser: Browser; engine: Engine }
export function boxId(box: Box): string { return `${box.framework}/${box.browser}/${box.engine}`; }
export function inventory(): Box[] {
  return frameworks.flatMap(framework => browsers.flatMap(browser => engines.map(engine => ({ framework: framework.id, browser, engine }))));
}
