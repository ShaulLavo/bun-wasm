export const projectTemplates = [
  { id: "vite-react", label: "Vite + React", directory: "template", file: "vite-react.json", editorFile: "src/App.tsx" },
  { id: "next", label: "Next.js", directory: "template-next", file: "next.json", editorFile: "pages/index.tsx" },
  { id: "next-app", label: "Next.js App Router", directory: "template-next-app", file: "next-app.json", editorFile: "app/page.tsx" },
] as const;

export type ProjectTemplate = typeof projectTemplates[number];

export function projectTemplate(value: string | null): ProjectTemplate | undefined {
  return projectTemplates.find(template => template.id === value);
}
