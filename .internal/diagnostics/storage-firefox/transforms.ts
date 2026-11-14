import assert from "node:assert/strict";
import { join } from "node:path";

export function replaceOnce(source: string, needle: string, value: string) {
  assert.equal(source.split(needle).length, 2, `unique original seam: ${needle}`);
  return source.replace(needle, value);
}
export function sandboxModel(original: string, report: string) {
  let source = `import { runEntryControls, type EntryCommand } from ${JSON.stringify(join(report, "controls.ts"))};\n` + original;
  const runtime = '    const runtime = createRuntime({ filesystem: { mode, name: workspaceName(this.template) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });';
  source = replaceOnce(source, runtime, runtime + '\n    Reflect.get(globalThis, "sandboxObserver").registerRuntime(runtime);');
  source = replaceOnce(source, '    await this.command("dev", options, visibleStart, revision);', '    if (this.params.get("entryControls") === "labelled") await runEntryControls(spec => this.command("dev", options, visibleStart, revision, spec));\n    await this.command("dev", options, visibleStart, revision);');
  source = replaceOnce(source, 'visibleStart: number, revision: number): Promise<RunResult | undefined> {', 'visibleStart: number, revision: number, control?: EntryCommand): Promise<RunResult | undefined> {');
  source = replaceOnce(source, '    const args = script === "install" ? ["install"] : ["run", "dev"];', '    const args = control?.args ?? (script === "install" ? ["install"] : ["run", "dev"]);');
  source = replaceOnce(source, '    const current = startRun({ ...options, args }, hooks);', '    const effectiveOptions = control ? { ...options, env: { ...options.env, ...control.env } } : options;\n    const observer = Reflect.get(globalThis, "sandboxObserver");\n    observer.beginCommand(control ?? { id: "original-" + script, args, kind: "original" });\n    const current = startRun({ ...effectiveOptions, args }, hooks);');
  source = replaceOnce(source, '    output.flush();', '    output.flush();\n    observer.record({ kind: "original-command-completed", commandId: control?.id ?? "original-" + script, script, args, outcome: { done: true, code: result.code, error: result.error ?? null, output: diagnostic } });');
  return replaceOnce(source, '    this.run = null;\n    if (script === "install"', '    this.run = null;\n    if (control) return result;\n    if (script === "install"');
}
