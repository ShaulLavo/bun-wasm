import type { ScopedTransport } from "./transport";
declare const __GOALS_ANGULAR_DIAGNOSTIC__: string;
let source: Promise<string> | undefined;

export function namedAngularDiagnostic(output: string): string | undefined {
  let path: string | undefined;
  for (const match of output.matchAll(/^See "(\/tmp\/ng-[A-Za-z0-9_-]{1,64}\/angular-errors\.log)" for further details\.$/gm)) path = match[1];
  return path;
}

export async function buildAngularDiagnosticSource(): Promise<string> {
  const result = await Bun.build({ entrypoints: [new URL("./angular-diagnostic-browser.ts", import.meta.url).pathname], target: "browser", format: "iife", minify: true });
  if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, "Cannot build diagnostic reader");
  return result.outputs[0].text();
}

export async function angularDiagnostic(transport: ScopedTransport, path: string, deadline: number): Promise<string> {
  source ??= typeof __GOALS_ANGULAR_DIAGNOSTIC__ === "string" ? Promise.resolve(__GOALS_ANGULAR_DIAGNOSTIC__) : buildAngularDiagnosticSource();
  const script = await source;
  if (Date.now() >= deadline) throw new Error("Failure observation deadline expired");
  const text = await transport.evaluate<string>(`(() => { ${script}\nconst read = globalThis.__goalsReadAngularDiagnostic; delete globalThis.__goalsReadAngularDiagnostic; return read(${JSON.stringify({ path, deadline })}); })()`);
  return `\n\n--- Guest Angular diagnostic: ${path} ---\n${text}\n--- End guest Angular diagnostic ---\n`;
}
