export type ObserverRecord = {
  probe: string;
  stage: string;
  at: number;
  details: Record<string, unknown>;
};

type CachedModule = {
  label: string;
  path: string;
  defaultConstructor?: string;
  namedFunctions?: string[];
};

type Hook = {
  target: string;
  installed: string[];
};

type Registration = {
  nextWorker: boolean;
  runtime: string | undefined;
  argv1: string;
  pid: number;
  moduleCacheAccess: boolean;
  provider: string;
  modules: CachedModule[];
  hooks: Hook[];
};

type ObserverState = {
  registered: boolean;
  registration: Registration | null;
  records: ObserverRecord[];
  dropped: number;
};

const stateKey = Symbol.for("bun-wasm.browser-error-phase-observer");
const globalState = globalThis as typeof globalThis & { [stateKey]?: ObserverState };

export function getObserverState(): ObserverState {
  const existing = globalState[stateKey];
  if (existing) return existing;
  const created: ObserverState = { registered: false, registration: null, records: [], dropped: 0 };
  globalState[stateKey] = created;
  return created;
}

export function markRegistered(): void {
  const state = getObserverState();
  state.registered = true;
  state.registration = {
    nextWorker: process.env.NEXT_PRIVATE_WORKER === "1",
    runtime: process.env.NEXT_RUNTIME,
    argv1: process.argv[1] ?? "",
    pid: process.pid,
    moduleCacheAccess: false,
    provider: "module.createRequire",
    modules: [],
    hooks: [],
  };
}

export function setRegistration(update: Partial<Registration>): void {
  const state = getObserverState();
  if (!state.registration) return;
  Object.assign(state.registration, update);
}

export function markHookInstalled(target: string): void {
  const state = getObserverState();
  const hooks = state.registration?.hooks;
  if (!hooks) return;
  if (hooks.some(hook => hook.target === target)) return;
  hooks.push({ target, installed: [target] });
}

export function record(probe: string, stage: string, details: Record<string, unknown> = {}): void {
  const state = getObserverState();
  if (state.records.length >= 4096) {
    state.dropped++;
    return;
  }
  const at = Date.now();
  state.records.push({ probe, stage, at, details });
  try {
    process.stderr.write("[guest-error-phase] " + JSON.stringify({ probe, stage, at, ...details }) + "\n");
  } catch {}
}

export function observerSnapshot() {
  const state = getObserverState();
  const stages: Record<string, number> = {};
  for (const item of state.records) stages[item.stage] = (stages[item.stage] ?? 0) + 1;
  return {
    hook: "next-instrumentation-register",
    servingContext: state.registered && state.registration?.nextWorker === true,
    registered: state.registered,
    registration: state.registration,
    recordCount: state.records.length,
    dropped: state.dropped,
    stages,
  };
}
