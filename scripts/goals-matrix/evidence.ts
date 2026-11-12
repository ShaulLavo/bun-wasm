import type { Phase } from "./model";
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an evidence object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.length) throw new Error("Expected a nonempty string");
  return value;
}
function rendered(value: unknown): void { const data = object(value); text(data.text); if (data.matched !== true) throw new Error("Render evidence did not match"); }
function clicked(value: unknown): void {
  const data = object(value);
  if (typeof data.before !== "string" || typeof data.after !== "string" || data.before === data.after || !/1/.test(data.after)) throw new Error("Click evidence did not change the counter");
}
export function observed(phase: Phase, value: unknown, engine: string): void {
  const data = object(value);
  switch (phase) {
    case "startup":
      if (data.ready !== true || data.engine !== engine || !/ready/.test(text(data.status))) throw new Error("Startup evidence does not identify the ready engine");
      text(data.agent); return;
    case "install": case "build":
      if (data.done !== true || data.code !== 0 || data.error !== null || typeof data.output !== "string") throw new Error("Command evidence is not a completed zero exit");
      return;
    case "dev": if (!/^https?:\/\//.test(text(data.url))) throw new Error("Missing dev listener URL"); return;
    case "render": rendered(data); return;
    case "click": clicked(data); return;
    case "hot-reload":
      text(data.updated);
      if (typeof data.before !== "string" || typeof data.sameDocument !== "boolean" || data.manualNavigations !== 0) throw new Error("Missing non-navigating hot-reload evidence");
      rendered(data.result); return;
    case "preview": rendered(data.rendered); clicked(data.clicked); return;
    case "cleanup":
      if (data.transportCreated === false) return;
      if (data.browserClosed !== true || data.foregroundStopped !== true || data.previewClosed !== true) throw new Error("Incomplete cleanup evidence");
      return;
    default: { const exhaustive: never = phase; throw new Error(`Unknown phase ${exhaustive}`); }
  }
}
