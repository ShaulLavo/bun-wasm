import type { Runtime } from "waffle";

export type ProcessRuntime = Pick<Runtime,
  "hostIdentity" | "filesystem" | "identities" | "disposed"
  | "registerProgram" | "registerAdapter" | "registerHostAdapter" | "retainConsumer"
  | "network" | "processes" | "dispose" | "sharedMemory"
>;
