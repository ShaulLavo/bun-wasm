import { on, type Handle } from "@remix-run/component";
import type { Sandbox } from "./sandbox";

interface Folder {
  folders: Map<string, Folder>;
  files: string[];
}

function fileTree(paths: readonly string[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const path of paths) {
    let folder = root;
    for (const part of path.split("/").slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) folder.folders.set(part, (next = { folders: new Map(), files: [] }));
      folder = next;
    }
    folder.files.push(path);
  }
  return root;
}

export function FileTree(handle: Handle<{ sandbox: Sandbox }>) {
  /** Folders that are closed; node_modules starts closed. */
  const closed = new Set<string>(["node_modules"]);
  const toggle = (path: string) => {
    if (!closed.delete(path)) closed.add(path);
    const { sandbox } = handle.props;
    void handle.update();
    void sandbox.refreshFiles().catch(sandbox.report);
  };

  function items(folder: Folder, prefix: string, depth: number) {
    const { sandbox } = handle.props;
    const folders = Array.from(folder.folders).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => {
      const path = prefix + name;
      const open = !closed.has(path);
      return (
        <li key={path} role="treeitem" aria-expanded={open}>
          <button type="button" class="folder" style={`--depth: ${depth}`} mix={on("click", () => toggle(path))}>
            <span class="icon">{open ? "▾" : "▸"}</span>{name}
          </button>
          {open && <ul role="group">{items(child, `${path}/`, depth + 1)}</ul>}
        </li>
      );
    });
    const files = folder.files.sort().map((path) => (
      <li key={path} role="treeitem">
        <button
          type="button" class="file" style={`--depth: ${depth}`} data-path={path}
          aria-current={path === sandbox.editor?.path ? "true" : undefined}
          mix={on("click", () => void sandbox.editor?.open(path).catch(sandbox.report))}
        >
          <span class="icon"></span>{path.slice(prefix.length)}
        </button>
      </li>
    ));
    return folders.concat(files);
  }

  return () => (
    <nav class="pane files" aria-label="Files">
      <div class="pane-title">Files</div>
      <ul id="tree" role="tree">{items(fileTree(handle.props.sandbox.files), "", 0)}</ul>
    </nav>
  );
}
