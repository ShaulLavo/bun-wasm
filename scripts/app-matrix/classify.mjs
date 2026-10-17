import { exitProvenance } from "./exit-provenance.ts";

export function stageOutput(log, command) {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const start = lines.findLastIndex(line => line.endsWith(`user@bun:~$ ${command}`));
  if (start === -1) throw new Error(`Missing stage boundary for ${command}`);
  const end = lines.findIndex((line, index) => index > start && /user@bun:~\$/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

export function firstError(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map(line => line.trim().replace(/^\d{1,2}:\d{2}:\d{2} [AP]M \[vite\] (?:\([^)]*\) )?/, "").replace(/^(?:unhandledRejection|uncaughtException)\s+\[?(\w*Error:.*?)\]?$/, "$1").replace(/^\[((?:\w*Error|error):.*)\]$/, "$1"));
  const diagnostic = lines.find(line => /^(?:(?:\w*Error|error|panic|fatal|bun-wasm|E[A-Z][A-Z0-9_]+):|Error when evaluating SSR module |The requested module .*does not provide an export named|memory allocation of \d+ bytes failed|thread '.+' panicked|[^|\n]+error TS\d+:)/i.test(line));
  const exit = exitProvenance({ code: null, output }).runtimeExits.at(-1);
  return (diagnostic ?? (exit ? `Runtime exited ${exit.code}: ${exit.reason}` : "No diagnostic before exit or deadline")).slice(0, 500);
}

export function failure(output, stage) {
  const blocker = firstError(output);
  if (/current platform .*wasm32|Native Prisma engine|native addon|\.node\b|dlopen|unsupported.*(platform|architecture)/i.test(blocker)) return { category: "a", blocker };
  if (/node:child_process|external executable|IPC.*not|spawn.*(not supported|not implemented)/i.test(blocker)) return { category: "b", blocker };
  if (/tryEnableSourceMapsForHost|legacy-cli\.mjs|No such module: fs/i.test(blocker)) return { category: "c", blocker };
  return { category: "d", blocker: `${stage}: ${blocker}` };
}

export function compareEngines(rows) {
  return rows.map(row => {
    if (row.engine !== "quickjs" || row.status !== "fail") return row;
    const passesOn = rows.filter(other => other.app === row.app && other.host === row.host && other.stage === row.stage && ["jsc", "browser"].includes(other.engine) && other.status === "pass").map(other => other.engine);
    return passesOn.length ? { ...row, category: "f", passesOn } : row;
  });
}
