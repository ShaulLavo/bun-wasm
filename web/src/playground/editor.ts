import { javascript } from "@codemirror/lang-javascript";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import type { Runtime } from "waffle";
import { HOME } from "../examples";
import { decode } from "../fs";

type Filesystem = Runtime["filesystem"];

export type EditorHost = {
  run(): Promise<void>;
  report(error: unknown): void;
  /** The file list, the open file or a dirty marker changed. */
  changed(): void;
  /** Optional host-managed claimed & teardown-tracked file writer. */
  saveFile?(path: string, text: string): Promise<void>;
};

function matchesChangedPath(openPath: string, changedPaths: ReadonlySet<string>): boolean {
  if (changedPaths.has(openPath)) return true;
  for (const changed of changedPaths) {
    if (changed === "" || openPath.startsWith(`${changed}/`) || changed.startsWith(`${openPath}/`)) {
      return true;
    }
  }
  return false;
}

/** One CodeMirror view over the files in ~. Each file keeps its own state, so undo survives tab switches. */
export class Editor {
  readonly view: EditorView;
  path = `${HOME}/index.ts`;
  /** The files in ~, plus open documents whose file was deleted. */
  files: string[] = [];
  private states = new Map<string, EditorState>();
  private saved = new Map<string, string>();
  private pathRevision = new Map<string, number>();
  private inFlightCount = new Map<string, number>();
  private deferredSync = new Set<string>();
  private saveChain: Promise<void> = Promise.resolve();
  private saveBusy = false;
  private opened = false;
  private openRevision = 0;
  private filesRevision = 0;

  constructor(private readonly fs: Filesystem, private readonly host: EditorHost) {
    // The view starts detached; the editor pane places view.dom.
    this.view = new EditorView({ state: EditorState.create({ extensions: this.extensions(this.path) }) });
  }

  private bumpPathRevision(path: string): number {
    const next = (this.pathRevision.get(path) ?? 0) + 1;
    this.pathRevision.set(path, next);
    return next;
  }

  private extensions(path: string): Extension[] {
    const ts = /\.(m|c)?tsx?$/.test(path);
    const jsx = /x$/.test(path);
    return [
      basicSetup,
      javascript({ typescript: ts, jsx }),
      oneDark,
      EditorView.lineWrapping,
      // Ahead of basicSetup, whose default keymap binds Mod-Enter to "insert blank line".
      Prec.high(keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (void this.save().catch(this.host.report), true) },
        { key: "Mod-Enter", preventDefault: true, run: () => (void this.host.run().catch(this.host.report), true) },
      ])),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          this.bumpPathRevision(path);
          void this.refreshFiles().catch(this.host.report);
        }
      }),
    ];
  }

  private async stateFor(path: string): Promise<EditorState> {
    let state = this.states.get(path);
    if (!state) {
      const text = decode(await this.fs.readFile(path) ?? new Uint8Array());
      // Another open may have populated (and edited) this file while the read was pending.
      state = this.states.get(path);
      if (state) return state;
      state = EditorState.create({ doc: text, extensions: this.extensions(path) });
      this.states.set(path, state);
      this.saved.set(path, text);
    }
    return state;
  }

  dirty(path: string): boolean {
    const state = path === this.path ? this.view.state : this.states.get(path);
    return state !== undefined && state.doc.toString() !== this.saved.get(path);
  }

  async open(path: string): Promise<void> {
    const revision = ++this.openRevision;
    if (path !== this.path || !this.opened) {
      await this.stateFor(path);
      if (revision !== this.openRevision) return;
      // Keep path and view paired until the requested state is ready. Typing and saves
      // during the read still belong to the file currently on screen.
      if (this.opened && this.path && this.states.has(this.path)) this.states.set(this.path, this.view.state);
      this.path = path;
      const target = this.states.get(path);
      if (target) this.view.setState(target);
      this.opened = true;
    }
    await this.refreshFiles();
  }

  async save(): Promise<void> {
    const path = this.path;
    if (!path) return;
    const text = this.view.state.doc.toString();
    this.inFlightCount.set(path, (this.inFlightCount.get(path) ?? 0) + 1);
    const perform = async () => {
      if (this.host.saveFile) {
        await this.host.saveFile(path, text);
      } else {
        await this.fs.writeFile(path, text);
        await this.fs.flush(path);
      }
      this.saved.set(path, text);
      await this.refreshFiles();
    };
    const next = this.saveBusy
      ? this.saveChain.then(perform, perform)
      : perform();
    this.saveBusy = true;
    const tracked = next.catch(() => {});
    this.saveChain = tracked;
    void tracked.then(() => {
      if (this.saveChain === tracked) this.saveBusy = false;
    });
    try {
      await next;
    } finally {
      const remaining = (this.inFlightCount.get(path) ?? 1) - 1;
      if (remaining <= 0) {
        this.inFlightCount.delete(path);
        if (this.deferredSync.delete(path)) {
          void this.syncPaths([path]).catch(this.host.report);
        }
      } else {
        this.inFlightCount.set(path, remaining);
      }
    }
  }

  async syncPaths(relativeOrAbsolutePaths: readonly string[]): Promise<void> {
    const absSet = new Set(
      relativeOrAbsolutePaths.map((p) => (p.startsWith("/") ? p : `${HOME}/${p.replace(/^\/+/, "")}`)),
    );
    if (this.opened && this.path && this.states.has(this.path)) {
      this.states.set(this.path, this.view.state);
    }
    for (const path of Array.from(this.states.keys())) {
      if (matchesChangedPath(path, absSet)) {
        await this.syncFile(path);
      }
    }
    await this.ensureActiveFileFallback();
    await this.refreshFiles();
  }

  /** Pick up files created, changed or deleted by bun.wasm, the shell, or peer tabs. Unsaved edits win. */
  async syncFromFs(): Promise<void> {
    if (this.opened && this.path && this.states.has(this.path)) {
      this.states.set(this.path, this.view.state);
    }
    for (const path of Array.from(this.states.keys())) await this.syncFile(path);
    await this.ensureActiveFileFallback();
    await this.refreshFiles();
  }

  private async ensureActiveFileFallback(): Promise<void> {
    if (this.path && this.states.has(this.path)) return;
    const revision = this.openRevision;
    const list = await this.fs.listFiles(HOME);
    if (revision !== this.openRevision) return;
    const first = list[0];
    if (first) {
      await this.open(first);
    } else {
      this.path = "";
      this.view.setState(EditorState.create({ extensions: [EditorState.readOnly.of(true)] }));
      this.host.changed();
    }
  }

  private async syncFile(path: string): Promise<void> {
    if ((this.inFlightCount.get(path) ?? 0) > 0) {
      this.deferredSync.add(path);
      return;
    }
    const revBefore = this.pathRevision.get(path) ?? 0;
    const data = await this.fs.readFile(path);
    if ((this.inFlightCount.get(path) ?? 0) > 0) {
      this.deferredSync.add(path);
      return;
    }
    const revAfter = this.pathRevision.get(path) ?? 0;
    const dirtyNow = this.dirty(path) || revAfter !== revBefore;
    if (!data) {
      if (!dirtyNow) {
        this.states.delete(path);
        this.saved.delete(path);
        if (this.path === path) {
          this.path = "";
          this.view.setState(EditorState.create({ extensions: [EditorState.readOnly.of(true)] }));
        }
      }
      return;
    }
    const text = decode(data);
    if (text === this.saved.get(path) || dirtyNow) return;
    const state = path === this.path ? this.view.state : this.states.get(path);
    if (!state) return;
    this.saved.set(path, text);
    const next = state.update({ changes: { from: 0, to: state.doc.length, insert: text } }).state;
    this.states.set(path, next);
    if (path === this.path) this.view.setState(next);
  }

  private async refreshFiles(): Promise<void> {
    const revision = ++this.filesRevision;
    const files = await this.fs.listFiles(HOME);
    if (revision !== this.filesRevision) return;
    for (const path of this.states.keys()) if (!files.includes(path)) files.push(path);
    this.files = files;
    this.host.changed();
  }

  focus(): void {
    this.view.focus();
  }
}
