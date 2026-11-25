import { javascript } from "@codemirror/lang-javascript";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";

export type SaveState = { text: string; kind: "" | "ok" | "error" };

interface EditorReadResult {
  readonly text: string | null;
  readonly resetGeneration: number;
}

export type EditorHost = {
  /** The project's directory in the guest's filesystem. */
  app: string;
  /** Reads a file atomically paired with the workspace's current resetGeneration. */
  readFile(path: string, existingLease?: unknown, signal?: AbortSignal): Promise<EditorReadResult>;
  /** Optional file listing used for active-file deletion fallback. */
  listFiles?(existingLease?: unknown, signal?: AbortSignal): Promise<string[]>;
  /** Persists one save and tells the dev server; `revision` identifies the edit being saved. */
  save(
    path: string,
    text: string,
    revision: number,
    editResetGen: number,
    options?: { resolveConflict?: boolean },
  ): Promise<void>;
  checkpoint(signal?: AbortSignal): Promise<void>;
  currentResetGeneration?(): number;
  isResetting?(): boolean;
  /** The open file or the save state changed. */
  changed(): void;
};

const SAVE_DELAY_MS = 350;

async function language(path: string): Promise<Extension> {
  if (/\.css$/.test(path)) return (await import("@codemirror/lang-css")).css();
  if (/\.html?$/.test(path)) return (await import("@codemirror/lang-html")).html();
  return javascript({ typescript: /\.(m|c)?tsx?$/.test(path), jsx: /x$/.test(path) });
}

function matchesChangedPath(openPath: string, changedPaths: ReadonlySet<string>): boolean {
  if (changedPaths.has(openPath)) return true;
  for (const changed of changedPaths) {
    if (changed === "" || openPath.startsWith(`${changed}/`) || changed.startsWith(`${openPath}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Page-owned CodeMirror view over the project.
 * Holds NO captured Filesystem reference so runtime recycles never unmount the editor or hide unsaved text.
 */
export class Editor {
  /** Starts detached; the editor pane places view.dom. */
  readonly view = new EditorView({});
  path = "";
  saveState: SaveState = { text: "", kind: "" };
  readonly conflicted = new Set<string>();

  private states = new Map<string, EditorState>();
  private saved = new Map<string, string>();
  private bufferResetGen = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, number>();
  private pathRevision = new Map<string, number>();
  private inFlight = new Map<string, Promise<void>>();
  private deferredSync = new Set<string>();
  private loading = new Map<string, symbol>();
  private invalidatedLoads = new Set<string>();
  private saves?: Promise<void>;
  private openRevision = 0;
  private editRevision = 0;
  private discardGeneration = 0;
  private loadGeneration = 0;
  private autosavePaused = false;

  constructor(private readonly host: EditorHost) {}

  private async extensions(path: string): Promise<Extension[]> {
    const readOnly = path.startsWith("node_modules/");
    return [
      basicSetup,
      await language(path),
      oneDark,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (this.flushInBackground(path, { resolveConflict: true }), true) }]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !readOnly) this.schedule(path);
      }),
    ];
  }

  private bumpPathRevision(path: string): number {
    const next = (this.pathRevision.get(path) ?? 0) + 1;
    this.pathRevision.set(path, next);
    return next;
  }

  private text(path: string): string {
    return (path === this.path ? this.view.state : this.states.get(path))?.doc.toString() ?? "";
  }

  isDirty(path: string): boolean {
    if (this.pending.has(path)) return true;
    const state = path === this.path ? this.view.state : this.states.get(path);
    if (!state) return false;
    const savedText = this.saved.get(path);
    return savedText !== undefined && state.doc.toString() !== savedText;
  }

  get hasPending(): boolean {
    return this.pending.size !== 0;
  }

  /** Invalidates in-flight loads WITHOUT touching published states, saved text, path, or bufferResetGen. */
  invalidatePendingLoads(): void {
    this.loadGeneration++;
    this.loading.clear();
    this.invalidatedLoads.clear();
  }

  private async stateFor(
    path: string,
    existingLease?: unknown,
    signal?: AbortSignal,
  ): Promise<EditorState | null> {
    const existing = this.states.get(path);
    if (existing) return existing;

    const token = Symbol("editor-load");
    this.loading.set(path, token);
    let cachedExtensions: Extension[] | undefined;
    try {
      while (true) {
        this.invalidatedLoads.delete(path);
        const loadGen = this.loadGeneration;
        const discardGen = this.discardGeneration;
        const { text, resetGeneration } = await this.host.readFile(path, existingLease, signal);
        if (!cachedExtensions) cachedExtensions = await this.extensions(path);
        if (
          loadGen !== this.loadGeneration ||
          discardGen !== this.discardGeneration ||
          this.loading.get(path) !== token
        ) {
          return null;
        }
        if (this.invalidatedLoads.has(path)) continue;
        const already = this.states.get(path);
        if (already) return already;
        const docText = text ?? "";
        const created = EditorState.create({ doc: docText, extensions: cachedExtensions });
        this.states.set(path, created);
        this.saved.set(path, docText);
        this.bufferResetGen.set(path, resetGeneration);
        return created;
      }
    } finally {
      if (this.loading.get(path) === token) this.loading.delete(path);
    }
  }

  /** A successful save cannot hide another document that still needs saving. */
  settle(revision: number, state: SaveState): boolean {
    let currentPending = false;
    let otherPending = false;
    for (const pending of this.pending.values()) {
      currentPending ||= pending === revision;
      otherPending ||= pending !== revision;
    }
    if (revision !== this.editRevision && (state.kind !== "ok" || !currentPending || otherPending)) return false;
    if (state.kind === "ok" && otherPending) {
      this.saveState = { text: "not saved: other files have pending changes", kind: "error" };
      this.host.changed();
      return false;
    }
    this.saveState = state;
    this.host.changed();
    return true;
  }

  /** Debounced save: typing a word is one update, not one per key. */
  private schedule(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.bumpPathRevision(path);
    this.pending.set(path, ++this.editRevision);
    if (this.conflicted.has(path)) {
      this.saveState = { text: "workspace was reset · press Ctrl/Cmd-S to overwrite", kind: "error" };
      this.host.changed();
      return;
    }
    this.saveState = { text: "editing…", kind: "" };
    this.host.changed();
    if (this.autosavePaused) return;
    this.timers.set(
      path,
      setTimeout(() => this.flushInBackground(path), SAVE_DELAY_MS),
    );
  }

  private flushInBackground(path: string, options?: { resolveConflict?: boolean }): void {
    void this.flush(path, options).catch(() => {});
  }

  async flush(path: string, options: { resolveConflict?: boolean } = {}): Promise<void> {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    if (!options.resolveConflict && (this.autosavePaused || this.conflicted.has(path))) {
      return;
    }
    const existing = this.inFlight.get(path);
    if (existing && !options.resolveConflict && !this.pending.has(path)) {
      return existing;
    }
    const revision = this.pending.get(path) ?? ++this.editRevision;
    this.pending.set(path, revision);
    const capturedText = this.text(path);
    const capturedResetGen = options.resolveConflict
      ? (this.host.currentResetGeneration?.() ?? this.bufferResetGen.get(path) ?? 0)
      : (this.bufferResetGen.get(path) ?? this.host.currentResetGeneration?.() ?? 0);
    const capturedPathRev = this.pathRevision.get(path) ?? 0;

    const runSave = () => this.host.save(path, capturedText, revision, capturedResetGen, options);
    const save = this.saves ? this.saves.then(runSave) : runSave();
    const settled = save.catch(() => {}).finally(() => {
      if (this.saves === settled) this.saves = undefined;
      if (this.inFlight.get(path) === save) this.inFlight.delete(path);
    });
    this.saves = settled;
    this.inFlight.set(path, save);

    try {
      await save;
      this.saved.set(path, capturedText);
      this.bufferResetGen.set(path, capturedResetGen);
      if (options.resolveConflict) this.conflicted.delete(path);
      if (this.pending.get(path) === revision && (this.pathRevision.get(path) ?? 0) === capturedPathRev) {
        this.pending.delete(path);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "ResetGenerationMismatchError") {
        this.conflicted.add(path);
        this.settle(revision, { text: "workspace was reset · press Ctrl/Cmd-S to overwrite", kind: "error" });
      } else {
        this.settle(revision, { text: `not saved: ${String(error)}`, kind: "error" });
      }
      throw error;
    } finally {
      if (this.deferredSync.delete(path) && !this.inFlight.has(path)) {
        void this.syncPaths([path]).catch(() => {});
      }
    }
  }

  async flushAll(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.autosavePaused) {
      await this.saves;
      return;
    }
    while (true) {
      signal?.throwIfAborted();
      const paths = Array.from(this.pending.keys()).filter((p) => !this.conflicted.has(p));
      if (paths.length === 0) break;
      await Promise.all(paths.map((p) => this.flush(p)));
    }
    signal?.throwIfAborted();
    await this.saves;
    signal?.throwIfAborted();
    await this.host.checkpoint(signal);
  }

  async waitForSaves(): Promise<void> {
    await this.saves;
  }

  async open(path: string, existingLease?: unknown, signal?: AbortSignal): Promise<void> {
    if (this.host.isResetting?.()) return;
    const openRev = ++this.openRevision;
    const loadGen = this.loadGeneration;
    const discardGen = this.discardGeneration;
    if (path === this.path && this.states.has(path)) return;
    const loaded = await this.stateFor(path, existingLease, signal);
    if (
      !loaded ||
      openRev !== this.openRevision ||
      loadGen !== this.loadGeneration ||
      discardGen !== this.discardGeneration
    ) {
      return;
    }
    const current = this.states.get(path);
    if (!current) return;
    if (this.path && this.states.has(this.path)) this.states.set(this.path, this.view.state);
    this.path = path;
    this.view.setState(current);
    this.host.changed();
  }

  async syncPaths(paths: readonly string[], existingLease?: unknown, signal?: AbortSignal): Promise<void> {
    if (this.host.isResetting?.() || signal?.aborted) return;
    const changedSet = new Set(paths.map((p) => p.replace(/^\/+/, "")));
    for (const loadingPath of this.loading.keys()) {
      if (matchesChangedPath(loadingPath, changedSet)) {
        this.invalidatedLoads.add(loadingPath);
      }
    }
    if (this.path && this.states.has(this.path)) {
      this.states.set(this.path, this.view.state);
    }
    const targets = Array.from(this.states.keys()).filter((p) => matchesChangedPath(p, changedSet));
    for (const p of targets) {
      if (signal?.aborted || this.host.isResetting?.()) return;
      await this.syncFile(p, existingLease, signal);
    }
    await this.ensureActiveBufferValid(existingLease, signal);
  }

  async syncFromFs(existingLease?: unknown, signal?: AbortSignal): Promise<void> {
    if (this.host.isResetting?.() || signal?.aborted) return;
    for (const loadingPath of this.loading.keys()) {
      this.invalidatedLoads.add(loadingPath);
    }
    if (this.path && this.states.has(this.path)) {
      this.states.set(this.path, this.view.state);
    }
    for (const p of Array.from(this.states.keys())) {
      if (signal?.aborted || this.host.isResetting?.()) return;
      await this.syncFile(p, existingLease, signal);
    }
    await this.ensureActiveBufferValid(existingLease, signal);
  }

  private async syncFile(path: string, existingLease?: unknown, signal?: AbortSignal): Promise<void> {
    if (this.conflicted.has(path)) return;
    if (this.inFlight.has(path)) {
      this.deferredSync.add(path);
      return;
    }
    const discardGen = this.discardGeneration;
    const loadGen = this.loadGeneration;
    const revBefore = this.pathRevision.get(path) ?? 0;
    const { text, resetGeneration } = await this.host.readFile(path, existingLease, signal);
    if (signal?.aborted || this.host.isResetting?.()) return;
    if (discardGen !== this.discardGeneration || loadGen !== this.loadGeneration) return;
    if (this.inFlight.has(path)) {
      this.deferredSync.add(path);
      return;
    }

    const revAfter = this.pathRevision.get(path) ?? 0;
    const dirtyNow = this.isDirty(path) || revAfter !== revBefore;
    const prevGen = this.bufferResetGen.get(path) ?? 0;

    if (dirtyNow) {
      if (resetGeneration !== prevGen) {
        this.conflicted.add(path);
        clearTimeout(this.timers.get(path));
        this.timers.delete(path);
        this.saveState = { text: "workspace was reset · press Ctrl/Cmd-S to overwrite", kind: "error" };
        this.host.changed();
      }
      return;
    }

    if (text === null) {
      this.states.delete(path);
      this.saved.delete(path);
      this.bufferResetGen.delete(path);
      if (this.path === path) {
        this.path = "";
        this.view.setState(EditorState.create({ extensions: [EditorState.readOnly.of(true)] }));
      }
      this.host.changed();
      return;
    }

    // Clean buffer: always adopt latest resetGeneration even when bytes are identical.
    this.bufferResetGen.set(path, resetGeneration);
    if (text === this.saved.get(path)) return;
    const state = path === this.path ? this.view.state : this.states.get(path);
    if (!state) return;
    this.saved.set(path, text);
    const next = state.update({ changes: { from: 0, to: state.doc.length, insert: text } }).state;
    this.states.set(path, next);
    if (path === this.path) this.view.setState(next);
    this.host.changed();
  }

  private async ensureActiveBufferValid(existingLease?: unknown, signal?: AbortSignal): Promise<void> {
    if (this.path !== "" || signal?.aborted || this.host.isResetting?.()) return;
    if (!this.host.listFiles) return;
    const openRev = this.openRevision;
    const files = await this.host.listFiles(existingLease, signal);
    if (signal?.aborted || this.host.isResetting?.() || openRev !== this.openRevision) return;
    const first = files.find((p) => !p.startsWith("node_modules/"));
    if (first) {
      await this.open(first, existingLease, signal);
    } else {
      this.view.setState(EditorState.create({ extensions: [EditorState.readOnly.of(true)] }));
      this.host.changed();
    }
  }

  /** Pauses autosave timers/flushes while RETAINING all open buffers, dirty text, path, and states. */
  suspendAutosaveForReset(): void {
    this.autosavePaused = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Unpauses autosave for non-conflicted dirty buffers; keeps conflicted buffers paused until explicit Mod-s. */
  resumeAfterReset(): void {
    this.autosavePaused = false;
    for (const path of this.pending.keys()) {
      if (this.conflicted.has(path)) continue;
      if (!this.timers.has(path)) {
        this.timers.set(
          path,
          setTimeout(() => this.flushInBackground(path), SAVE_DELAY_MS),
        );
      }
    }
  }

  markAllOpenConflicted(): void {
    for (const path of this.states.keys()) {
      this.conflicted.add(path);
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.conflicted.size > 0) {
      this.saveState = { text: "workspace was reset · press Ctrl/Cmd-S to overwrite", kind: "error" };
      this.host.changed();
    }
  }

  /** A committed reset discards all buffers and prevents typing from racing reload/re-seed. */
  discard(): void {
    this.discardGeneration++;
    this.loadGeneration++;
    this.openRevision++;
    this.editRevision++;
    this.path = "";
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.states.clear();
    this.saved.clear();
    this.bufferResetGen.clear();
    this.conflicted.clear();
    this.deferredSync.clear();
    this.loading.clear();
    this.invalidatedLoads.clear();
    this.inFlight.clear();
    this.view.setState(EditorState.create({ extensions: [EditorState.readOnly.of(true)] }));
    this.host.changed();
  }

  /** Replaces a file's text (tests use this to type like a person would). */
  setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }
}
