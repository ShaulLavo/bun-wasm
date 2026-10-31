export const templates = [
  { id: "react", label: "React", directory: "template", file: "template.json", editorFile: "src/App.tsx" },
  { id: "vanilla", label: "Vanilla TS", directory: "template-vanilla", file: "template-vanilla.json", editorFile: "src/main.ts" },
] as const;

export type Template = typeof templates[number];
export const defaultTemplate = templates[0];

export function selectTemplate(value: string | null): Template {
  return templates.find(template => template.id === value) ?? defaultTemplate;
}
