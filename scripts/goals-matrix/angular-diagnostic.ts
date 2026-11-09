import type { Runtime } from "waffle";
import type { Transport } from "./transport";

declare const playground: { fs?: Pick<Runtime["filesystem"], "lookup" | "readFile"> };

export function namedAngularDiagnostic(output: string): string | undefined {
  return /^See "(\/tmp\/ng-[A-Za-z0-9_-]{1,64}\/angular-errors\.log)" for further details\.$/m.exec(output)?.[1];
}

async function readDiagnostic(input: { path: string; deadline: number }): Promise<string> {
  const fs = playground.fs;
  if (!fs) throw new Error("Guest filesystem unavailable");
  const directory = input.path.slice(0, input.path.lastIndexOf("/"));
  const entries: [string, string][] = [["/tmp", "dir"], [directory, "dir"], [input.path, "file"]];
  for (const [path, kind] of entries) {
    if (Date.now() >= input.deadline) throw new Error("Failure observation deadline expired");
    if ((await fs.lookup(path))?.kind !== kind) throw new Error("Diagnostic path is missing, non-regular or a symlink");
  }
  if (Date.now() >= input.deadline) throw new Error("Failure observation deadline expired");
  const bytes = await fs.readFile(input.path);
  if (!bytes) throw new Error("Diagnostic file unavailable");
  const tail = bytes.subarray(Math.max(0, bytes.length - 16_384));
  const lines = new TextDecoder().decode(tail).split("\n");
  const truncated = bytes.length > tail.length || lines.length > 100;
  return `${truncated ? "[truncated to last 16 KiB / 100 lines]\n" : ""}${lines.slice(-100).join("\n")}`;
}

export async function angularDiagnostic(transport: Transport, path: string, deadline: number): Promise<string> {
  const text = await transport.evaluate<string>(`(${readDiagnostic.toString()})(${JSON.stringify({ path, deadline })})`);
  return `\n\n--- Guest Angular diagnostic: ${path} ---\n${text}\n--- End guest Angular diagnostic ---\n`;
}
