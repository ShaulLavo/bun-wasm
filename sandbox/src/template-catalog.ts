import { projectTemplates } from "../../web/src/playground/project-templates";

export type Template = Record<keyof typeof projectTemplates[number], string>;
export const defaultTemplate = { ...projectTemplates[0], file: "template.json" };

const sandboxTemplates: Template[] = [
  defaultTemplate,
  { id: "next", label: "Next.js", directory: "template-next", file: "template-next.json", editorFile: "pages/index.tsx" },
  { id: "next-app", label: "Next.js App Router", directory: "template-next-app", file: "template-next-app.json", editorFile: "app/page.tsx" },
  { id: "vanilla", label: "Vanilla TS", directory: "template-vanilla", file: "template-vanilla.json", editorFile: "src/main.ts" },
];

const sandboxIds = new Set(sandboxTemplates.map(template => template.id));
export const templates = sandboxTemplates.concat(projectTemplates.filter(template => !sandboxIds.has(template.id)));

export function selectTemplate(value: string | null): Template {
  return templates.find(template => template.id === value) ?? defaultTemplate;
}
