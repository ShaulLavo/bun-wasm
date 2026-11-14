export type Entry = "bun" | "shell";
export type Fault = "client" | "service";
export type EntryCommand = {
  id: string;
  entry: Entry;
  kind: "positive" | "fault" | "survivor";
  args: string[];
  env: Record<string, string>;
  marker: string | null;
  fault: Fault | null;
};
function command(id: string, entry: Entry, kind: EntryCommand["kind"], fault: Fault | null): EntryCommand {
  const marker = fault ? null : `SB84_${id}`;
  const line = fault ? "echo FAULT_GUEST_UNEXPECTED" : `printf '%s%s\n' 'SB84_' '${id}'`;
  const shell = `try { const r = Bun.spawnSync(["/bin/bash", "-c", ${JSON.stringify(line)}], {stdout:"inherit", stderr:"inherit", env:process.env}); process.exit(typeof r.exitCode === "number" ? r.exitCode : 1); } catch (error) { console.error(String(error)); process.exit(1); }`;
  const bun = fault ? 'console.log("FAULT_GUEST_UNEXPECTED")' : `console.log("SB84_" + ${JSON.stringify(id)})`;
  return { id, entry, kind, fault, marker, args: ["-e", entry === "shell" ? shell : bun],
    env: fault ? { QUALIFY_COMMAND_ID: id, QUALIFY_TARGET: entry, QUALIFY_FAULT: fault } : { QUALIFY_COMMAND_ID: id } };
}
export const positives = [command("bun-positive", "bun", "positive", null), command("shell-positive", "shell", "positive", null)];
const faultCases: Array<{ entry: Entry; fault: Fault }> = [{ entry: "bun", fault: "client" }, { entry: "bun", fault: "service" }, { entry: "shell", fault: "client" }, { entry: "shell", fault: "service" }];
export const faults = faultCases.map(({ entry, fault }) => command(`${entry}-${fault}`, entry, "fault", fault));
export const survivors = faults.map(spec => command(`survivor-${spec.id}`, "bun", "survivor", null));

type Observer = { gate(phase: string): Promise<void> };
export async function runEntryControls(run: (spec: EntryCommand) => Promise<unknown>) {
  const observer: Observer = Reflect.get(globalThis, "sandboxObserver");
  for (const spec of positives) await run(spec);
  await observer.gate("positives");
  for (const [index, spec] of faults.entries()) {
    await run(spec);
    await observer.gate(spec.id);
    await run(survivors[index]!);
    await observer.gate(survivors[index]!.id);
  }
  await observer.gate("before-original-dev");
}
