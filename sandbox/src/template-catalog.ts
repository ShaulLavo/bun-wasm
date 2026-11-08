import { projectTemplates } from "../../web/src/playground/project-templates";

export type Template = Record<keyof typeof projectTemplates[number], string>;
export const defaultTemplate = { id: "react", label: "React", directory: "template", file: "template.json", editorFile: "src/App.tsx" };

const sandboxTemplates: Template[] = [
  defaultTemplate,
  { id: "next", label: "Next.js", directory: "template-next", file: "template-next.json", editorFile: "pages/index.tsx" },
  { id: "next-app", label: "Next.js App Router", directory: "template-next-app", file: "template-next-app.json", editorFile: "app/page.tsx" },
  { id: "vanilla", label: "Vanilla TS", directory: "template-vanilla", file: "template-vanilla.json", editorFile: "src/main.ts" },
];

export const templates = sandboxTemplates.concat(projectTemplates.filter(template =>
  template.id !== "vite-react" && template.id !== "next" && template.id !== "next-app"));

export function selectTemplate(value: string | null): Template {
  return templates.find(template => template.id === value) ?? defaultTemplate;
}
