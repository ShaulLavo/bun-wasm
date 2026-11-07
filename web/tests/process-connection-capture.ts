import type { Runtime } from "waffle";

export type ProcessConnectionSnapshot = ReturnType<Runtime["sharedMemory"]["snapshot"]>;
