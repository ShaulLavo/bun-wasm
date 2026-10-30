import { javascript } from "@codemirror/lang-javascript";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import type { Runtime } from "waffle";
import { decode } from "../../web/src/fs";

type Filesystem = Runtime["filesystem"];
export type SaveState = { text: string; kind: "" | "ok" | "error" };

export type EditorHost = {
  /** The project's directory in the guest's filesystem. */
  app: string;
  /** Persists one save and tells the dev server; `revision` identifies the edit being saved. */
  save(path: string, text: string, revision: number): Promise<void>;
  /** The open file or the save state changed. */
  changed(): void;
};

const SAVE_DELAY_MS = 350;

async function language(path: string): Promise<Extension> {
  if (/\.css$/.test(path)) return (await import("@codemirror/lang-css")).css();
  if (/\.html?$/.test(path)) return (await import("@codemirror/lang-html")).html();
  return javascript({ typescript: /\.(m|c)?tsx?$/.test(path), jsx: /x$/.test(path) });
}

/** One CodeMirror view over the project. Each file keeps its own state, and edits save after a short pause. */
export class Editor {
  /** Starts detached; the editor pane places view.dom. */
  readonly view = new EditorView({});
  path = "";
  saveState: SaveState = { text: "", kind: "" };
  private states = new Map<string, EditorState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private revisions = new Map<string, number>();
  private openRevision = 0;
  private editRevision = 0;

  constructor(private readonly fs: Filesystem, private readonly host: EditorHost) {}

  private async extensions(path: string): Promise<Extension[]> {
    const readOnly = path.startsWith("node_modules/");
    return [
      basicSetup,
      await language(path),
      oneDark,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (this.flushInBackground(path), true) }]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !readOnly) this.schedule(path);
      }),
    ];
  }

  private async stateFor(path: string): Promise<EditorState> {
    let state = this.states.get(path);
    if (!state) {
      const text = decode(await this.fs.readFile(`${this.host.app}/${path}`) ?? new Uint8Array());
      const extensions = await this.extensions(path);
      state = this.states.get(path);
      if (state) return state;
      state = EditorState.create({ doc: text, extensions });
      this.states.set(path, state);
    }
    return state;
  }

  private text(path: string): string {
    return (path === this.path ? this.view.state : this.states.get(path))?.doc.toString() ?? "";
  }

  /** Shows a save's outcome only while it is still the newest edit. */
  settle(revision: number, state: SaveState): void {
    if (revision !== this.editRevision) return;
    this.saveState = state;
    this.host.changed();
  }

  /** Debounced save: typing a word is one update, not one per key. */
  private schedule(path: string): void {
    clearTimeout(this.timers.get(path));
    this.revisions.set(path, ++this.editRevision);
    this.saveState = { text: "editing…", kind: "" };
    this.host.changed();
    this.timers.set(
      path,
      setTimeout(() => this.flushInBackground(path), SAVE_DELAY_MS),
    );
  }

  private flushInBackground(path: string): void {
    // flush reports failures in the save indicator; event handlers have no promise consumer.
    void this.flush(path).catch(() => {});
  }

  async flush(path: string): Promise<void> {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    const revision = this.revisions.get(path) ?? this.editRevision;
    try {
      await this.host.save(path, this.text(path), revision);
    } catch (error) {
      this.settle(revision, { text: `not saved: ${String(error)}`, kind: "error" });
      throw error;
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all(Array.from(this.timers.keys(), (path) => this.flush(path)));
    await this.fs.flush();
  }

  async open(path: string): Promise<void> {
    const revision = ++this.openRevision;
    if (path === this.path) return;
    await this.stateFor(path);
    if (revision !== this.openRevision) return;
    if (this.path) this.states.set(this.path, this.view.state);
    this.path = path;
    this.view.setState(this.states.get(path)!);
    this.host.changed();
  }

  /** A reset discards pending edits and prevents typing from racing the template replacement. */
  discard(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.revisions.clear();
    this.states.clear();
    this.openRevision++;
    this.editRevision++;
    this.view.setState(EditorState.create({ extensions: [EditorState.readOnly.of(true)] }));
  }

  /** Replaces a file's text (tests use this to type like a person would). */
  setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }
}
