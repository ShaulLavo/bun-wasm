// Event-driven I/O pump gating for the Browser engine host. Skips hot `next === 0` turns when
// neither the process wake word, the filesystem watch word, net news, nor guest I/O transitions
// have fired within the safety ceiling, while keeping watch readiness authoritative on forced
// scans and notifications that do not advance `watchWord[3]` (such as per-process revocation).

export interface IoPumpGateOptions {
  readonly processWake?: Int32Array;
  readonly fsWatchWord?: () => Int32Array | undefined;
  readonly fsWatchReady?: () => boolean;
  readonly now?: () => number;
}

export interface IoPumpGate {
  markIoDirty(): void;
  markWatchDirty(): void;
  onNetNews(): void;
  onProcessWake(): void;
  beginPump(force?: boolean): boolean;
  endPump(progressed?: boolean): void;
  watchReady(): boolean;
}

export function createIoPumpGate(options: IoPumpGateOptions): IoPumpGate {
  const load = Atomics.load;
  const now = options.now ?? Date.now;
  const rescanMs = 16;
  let ioDirty = true;
  let watchDirty = true;
  let watchStillReady = false;
  let lastIoWake = NaN;
  let lastWatchWord = NaN;
  let lastIoPumpAt = 0;
  let inPump = false;
  let pumpWakeBefore = 0;
  let pumpWatchBefore = NaN;
  let pumpWatchAuthoritative = false;

  const currentWatchWord = () => options.fsWatchWord?.();

  return {
    markIoDirty() {
      ioDirty = true;
    },
    markWatchDirty() {
      watchDirty = true;
      watchStillReady = true;
      ioDirty = true;
    },
    onNetNews() {
      // Waffle per-process revocation notifies the watch word without incrementing it;
      // mark watches dirty so the next pump queries GuestWatchTable.ready() authoritatively.
      watchDirty = true;
      ioDirty = true;
    },
    onProcessWake() {
      ioDirty = true;
    },
    beginPump(force = false) {
      const wakeWord = options.processWake;
      if (!wakeWord) {
        inPump = true;
        pumpWatchAuthoritative = true;
        return true;
      }
      const wake = load(wakeWord, 0);
      const watchWord = currentWatchWord();
      const watchGen = watchWord ? load(watchWord, 3) : NaN;
      const watchChanged = Boolean(watchWord && watchGen !== lastWatchWord);
      const expired = now() - lastIoPumpAt >= rescanMs;
      if (
        !force &&
        !ioDirty &&
        !watchDirty &&
        !watchStillReady &&
        !watchChanged &&
        wake === lastIoWake &&
        !expired
      ) {
        return false;
      }
      ioDirty = false;
      pumpWatchAuthoritative = force || expired || watchDirty || watchStillReady || watchChanged;
      watchDirty = false;
      pumpWakeBefore = wake;
      pumpWatchBefore = watchGen;
      inPump = true;
      return true;
    },
    endPump(progressed = false) {
      inPump = false;
      if (!options.processWake) {
        pumpWatchAuthoritative = false;
        return;
      }
      lastIoWake = pumpWakeBefore;
      lastWatchWord = pumpWatchBefore;
      watchStillReady = pumpWatchAuthoritative ? Boolean(options.fsWatchReady?.()) : false;
      pumpWatchAuthoritative = false;
      if (progressed) ioDirty = true;
      lastIoPumpAt = now();
    },
    watchReady() {
      if (!options.fsWatchReady) return false;
      if (!inPump || pumpWatchAuthoritative || watchStillReady || watchDirty) {
        return Boolean(options.fsWatchReady());
      }
      const watchWord = currentWatchWord();
      if (!watchWord) return Boolean(options.fsWatchReady());
      return load(watchWord, 3) !== lastWatchWord
        ? Boolean(options.fsWatchReady())
        : false;
    },
  };
}
