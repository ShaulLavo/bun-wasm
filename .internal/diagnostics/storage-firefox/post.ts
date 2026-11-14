import { workerProcessState } from "../../../sandbox/node_modules/waffle/proc/worker-client.ts";
import { isRecord } from "./endpoint-identity.ts";

export function postedIdentity(value: unknown) {
  if (!isRecord(value) || !isRecord(value.filesystem) || !isRecord(value.filesystem.requests) || !isRecord(value.runtimeProcess)) return null;
  const transport = value.runtimeProcess;
  if (!(transport.directory instanceof SharedArrayBuffer) || typeof transport.slot !== "number" || typeof transport.generation !== "number" || typeof transport.pid !== "number") return null;
  const state = workerProcessState({ directory: transport.directory, slot: transport.slot, pid: transport.pid });
  return { owner: value.filesystem.owner, generation: value.filesystem.requests.generation, pid: state.pid, parentPid: state.parentPid,
    processGeneration: transport.generation, commandId: isRecord(value.env) ? value.env.QUALIFY_COMMAND_ID ?? null : null,
    args: value.args, engine: value.engine ?? null };
}

export function forwardPost<T extends (...args: never[]) => unknown>(native: T, receiver: unknown, args: unknown[], record: (row: object) => void, detail: object) {
  record({ kind: "native-request-post", ...detail });
  try {
    const result = Reflect.apply(native, receiver, args);
    record({ kind: "native-request-post-returned", ...detail });
    return result;
  } catch (error) {
    record({ kind: "native-request-post-threw", ...detail, error: String(error) });
    throw error;
  }
}
