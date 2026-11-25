import { SharedFilesystem as Filesystem } from "waffle/browser/shared-fs";
export * from "waffle/browser/shared-fs";

const initialParams = new URLSearchParams(location.search);
if (initialParams.has("takeover-startup") || initialParams.has("wait-startup")) {
  // Single-owner takeover/wait fixtures opt out of multi-tab attach coordination so they exercise
  // legacy `whenBusy: "takeover"` / `"wait"` modes (which do not use MultiTabBackend peer-alive locks).
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });
}
const pause = initialParams.has("pause-startup") && !sessionStorage.getItem("startup-paused");
let writesUntilFailure: number | undefined;
const state = { paused: false, resume: () => {}, failWriteAfter: (count: number) => { writesUntilFailure = count; } };
Object.assign(globalThis, { startupFilesystem: state });

export class SharedFilesystem extends Filesystem {
  constructor(options: ConstructorParameters<typeof Filesystem>[0] = {}, onStartupStage?: ConstructorParameters<typeof Filesystem>[1]) {
    const params = new URLSearchParams(location.search);
    if (params.has("takeover-startup") && options.mode !== "memory") {
      super({ ...options, whenBusy: "takeover" }, onStartupStage);
      return;
    }
    if (!params.has("wait-startup")) {
      super(options, onStartupStage);
      return;
    }
    if (options.mode !== "fast") throw new Error("Editor waiting control requires fast mode");
    super({ ...options, whenBusy: "wait" }, onStartupStage);
  }
  // Fault the real owner: page capabilities deliberately cannot be monkey-patched.
  override async writeFile(path: string, text: string | Uint8Array, append = false): Promise<void> {
    if (writesUntilFailure !== undefined) {
      if (writesUntilFailure > 0) --writesUntilFailure;
      if (writesUntilFailure === 0) throw new Error("interrupted reset");
    }
    await super.writeFile(path, text, append);
  }
  override async mkdirp(path: string): Promise<void> {
    await super.mkdirp(path);
    if (path === "/tmp" && new URLSearchParams(location.search).has("fail-startup") && !sessionStorage.getItem("startup-failed")) {
      sessionStorage.setItem("startup-failed", "1");
      throw new Error("injected filesystem startup failure");
    }
    if (!pause || path !== "/tmp") return;
    sessionStorage.setItem("startup-paused", "1");
    state.paused = true;
    await new Promise<void>(resolve => { state.resume = resolve; });
    await this.flush();
  }
}
