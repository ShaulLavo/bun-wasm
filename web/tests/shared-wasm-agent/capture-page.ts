import { captureProcessObserver, type ProcessObservationTransfer, type ProcessObserver } from "waffle/proc/observation";
import { captureBytes, readCapture } from "./capture";

type Member = { agent: string; argv: string[]; pid: number; buffer: SharedArrayBuffer; observer: ProcessObserver; messages: unknown[]; stop: string };
const members = new Map<Worker, Member>();

function retireOldCaptures(): void {
  for (const [worker, member] of members) {
    if (members.size < 64) return;
    if (member.stop === "native-terminate-returned") members.delete(worker);
  }
}

export function captureLaunch(worker: Worker, agent: string, data: unknown): unknown {
  if (!data || typeof data !== "object" || !("memoryGroup" in data) || !data.memoryGroup) return data;
  if (!("args" in data) || !Array.isArray(data.args) || !data.args.every(arg => typeof arg === "string")) throw new TypeError("Capture requires the actual member argv");
  const observation = "observation" in data && data.observation || "runtimeProcess" in data && data.runtimeProcess;
  if (!observation || typeof observation !== "object") throw new TypeError("Capture requires the admitted process observation");
  // Waffle supplied this transfer. Its public constructor validates the complete incarnation.
  const transfer = observation as ProcessObservationTransfer;
  const observer = captureProcessObserver(transfer);
  const buffer = new SharedArrayBuffer(captureBytes);
  retireOldCaptures();
  members.set(worker, { agent, argv: data.args.slice(), pid: transfer.pid, buffer, observer, messages: [], stop: "not-requested" });
  return { ...data, sharedWasmCapture: buffer };
}

export function captureMessage(worker: Worker, data: unknown): void {
  const member = members.get(worker);
  if (!member || !data || typeof data !== "object" || !("type" in data)) return;
  if (!["exit", "error", "cleanup-error", "observation-error"].includes(String(data.type))) return;
  member.messages = member.messages.slice(-3).concat([data]);
}

export function captureStop(worker: Worker, stop: string): void {
  const member = members.get(worker);
  if (member) member.stop = stop;
}

export function memberCaptures() {
  return Array.from(members.values(), member => ({
    agent: member.agent, pid: member.pid, argv: member.argv, stop: member.stop,
    observation: member.observer.read(), messages: member.messages, capture: readCapture(member.buffer),
  }));
}
