export const projectTemplates = [
  { id: "vite-react", label: "Vite + React", directory: "template", file: "vite-react.json", editorFile: "src/App.tsx" },
  { id: "next", label: "Next.js", directory: "template-next", file: "next.json", editorFile: "pages/index.tsx" },
  { id: "next-app", label: "Next.js App Router", directory: "template-next-app", file: "next-app.json", editorFile: "app/page.tsx" },
  { id: "nuxt", label: "Nuxt", directory: "template-nuxt", file: "nuxt.json", editorFile: "app.vue" },
  { id: "sveltekit", label: "SvelteKit", directory: "template-sveltekit", file: "sveltekit.json", editorFile: "src/routes/+page.svelte" },
  { id: "astro", label: "Astro", directory: "template-astro", file: "astro.json", editorFile: "src/pages/index.astro" },
  { id: "react-router", label: "React Router", directory: "template-react-router", file: "react-router.json", editorFile: "app/routes/home.tsx" },
  { id: "solidstart", label: "SolidStart", directory: "template-solidstart", file: "solidstart.json", editorFile: "src/routes/index.tsx" },
  { id: "tanstack-start", label: "TanStack Start", directory: "template-tanstack-start", file: "tanstack-start.json", editorFile: "src/routes/index.tsx" },
  { id: "angular", label: "Angular", directory: "template-angular", file: "angular.json", editorFile: "src/main.ts" },
  { id: "qwik", label: "Qwik", directory: "template-qwik", file: "qwik.json", editorFile: "src/routes/index.tsx" },
  { id: "vite-vue", label: "Vite + Vue", directory: "template-vite-vue", file: "vite-vue.json", editorFile: "src/App.vue" },
  { id: "vite-svelte", label: "Vite + Svelte", directory: "template-vite-svelte", file: "vite-svelte.json", editorFile: "src/App.svelte" },
  { id: "hono", label: "Hono", directory: "template-hono", file: "hono.json", editorFile: "src/page.html" },
] as const;

export type ProjectTemplate = typeof projectTemplates[number];

export function projectTemplate(value: string | null): ProjectTemplate | undefined {
  return projectTemplates.find(template => template.id === value);
}
