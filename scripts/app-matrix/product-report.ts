export interface ProductResultRow {
  app: string;
  engine: string;
  host: string;
  stage: string;
  status: "pass" | "fail" | "blocked";
  blocker?: string;
  prerequisite?: string;
}

interface Signature {
  id: string;
  owner: "Bun" | "Waffle" | "Unconfirmed";
  evidence: string;
}

export function observedSignature(message: string): Signature {
  if (/symlink|EACCES|EPERM|permission denied/i.test(message)) return { id: "filesystem capability", owner: "Waffle", evidence: message };
  if (/ENOSYS|not implemented.*(?:socket|descriptor|signal|pipe)|(?:socket|descriptor|signal|pipe).*not (?:implemented|supported)/i.test(message)) return { id: "runtime capability", owner: "Waffle", evidence: message };
  if (/HTTP 500|Preview HTTP 500/.test(message)) return { id: "dev server HTTP 500", owner: "Unconfirmed", evidence: message };
  if (/E696/.test(message)) return { id: "E696", owner: "Unconfirmed", evidence: message };
  if (/\.node\b|dlopen|unsupported.*(?:architecture|platform)/i.test(message)) return { id: "native package dependency", owner: "Unconfirmed", evidence: message };
  if (/HMR|WebSocket update|hot.reload/i.test(message)) return { id: "hot edit did not propagate", owner: "Unconfirmed", evidence: message };
  const normalized = message.replace(/\/work\/[^\s:]+/g, "<work-path>").replace(/https?:\/\/127\.0\.0\.1:\d+/g, "<fixture-origin>");
  return { id: normalized || "no diagnostic recorded", owner: "Unconfirmed", evidence: message };
}

export function unlockCandidates(rows: readonly ProductResultRow[]) {
  const groups = new Map<string, { signature: Signature; projects: Set<string>; stages: Set<string> }>();
  for (const row of rows) {
    if (row.status !== "fail") continue;
    const signature = observedSignature(row.blocker ?? "");
    const group = groups.get(signature.id) ?? { signature, projects: new Set<string>(), stages: new Set<string>() };
    group.projects.add(row.app);
    group.stages.add(row.stage);
    groups.set(signature.id, group);
  }
  return Array.from(groups.values(), group => ({
    ...group.signature, projects: Array.from(group.projects).sort(), stages: Array.from(group.stages).sort(),
    confidence: "Observed failure signature; shared root cause and unlock count need confirmation",
  })).sort((left, right) => right.projects.length - left.projects.length || left.id.localeCompare(right.id));
}

function cell(rows: readonly ProductResultRow[], stages: readonly string[]): string {
  const selected = rows.filter(row => stages.includes(row.stage));
  if (!selected.length) return "Not run";
  if (selected.some(row => row.status === "fail")) return "Fail";
  if (selected.some(row => row.status === "blocked")) return "Blocked";
  return "Pass";
}

export function productScoreboard(rows: readonly ProductResultRow[], projects: readonly { id: string; commands: readonly { name: string; check: { kind: string; hmr?: unknown } }[] }[]): string {
  const measured = rows.filter(row => row.engine === "browser" && row.host === "playground");
  const lines = ["| Project | Install | Dev/page | Hot edit | Build/tool | Start/preview |", "| --- | --- | --- | --- | --- | --- |"];
  for (const project of projects) {
    const app = measured.filter(row => row.app === project.id);
    const commands = project.commands.map(command => command.name);
    const development = commands.filter(name => name === "dev");
    const hot = project.commands.filter(command => command.name === "dev" && command.check.hmr).map(command => `${command.name}:hmr`);
    const build = commands.filter(name => !["dev", "start", "preview"].includes(name));
    const serve = commands.filter(name => name === "start" || name === "preview");
    const cells = [["install"], development, hot, build, serve].map(stages => stages.length ? cell(app, stages) : "Not applicable");
    lines.push(`| ${project.id} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}
