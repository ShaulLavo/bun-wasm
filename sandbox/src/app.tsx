import { on, type Handle } from "@remix-run/component";
import { EditorPane } from "./editor-pane";
import { FileTree } from "./file-tree";
import { PreviewPane } from "./preview-pane";
import type { Sandbox } from "./sandbox";
import { TerminalPane } from "./terminal-pane";
import { templates } from "./template-catalog";
import { SiteBrand, SiteNav } from "../../web/src/site-header";

type Props = { sandbox: Sandbox };

/** A clockwise arrow: restart the dev server. */
function RestartIcon() {
  return () => (
    <svg class="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M13 2.5V5h-2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** A counter-clockwise arrow: put the template back. */
function ResetIcon() {
  return () => (
    <svg class="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 8a5 5 0 1 0 1.46-3.54" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M3 2.5V5h2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

const ENGINE_OPTIONS = [["browser", "Browser (native)"], ["quickjs", "QuickJS"], ["jsc", "JSC"]] as const;
const RELOAD_TITLES = { construction: "Retry sandbox startup", startup: "Open the latest saved workspace", storage: "Retry saving and starting without leaving this page" };

export function App(handle: Handle<Props>) {
  const { sandbox } = handle.props;
  sandbox.addEventListener("change", () => void handle.update(), { signal: handle.signal });
  return () => (
    <>
      <Header sandbox={sandbox} />
      {sandbox.storageNotice && <p id="storage-status" role="status">{sandbox.storageNotice}</p>}
      <main>
        <FileTree sandbox={sandbox} />
        <EditorPane sandbox={sandbox} />
        <PreviewPane sandbox={sandbox} />
        <TerminalPane sandbox={sandbox} />
      </main>
    </>
  );
}

function Header(handle: Handle<Props>) {
  const { sandbox } = handle.props;
  const choose = (param: "engine" | "template") => on<HTMLSelectElement>("change", (event) => {
    void sandbox.navigate(param, event.currentTarget.value).catch(sandbox.report);
  });
  const reset = on<HTMLButtonElement>("click", () => {
    if (!confirm(`Reset the ${sandbox.template} workspace to its template? All changes in this workspace will be deleted.`)) return;
    void sandbox.reset();
  });
  const restart = on<HTMLButtonElement>("click", () => sandbox.restart());
  const startFresh = on<HTMLButtonElement>("click", () => {
    if (!confirm(`Delete this browser's saved ${sandbox.template} workspace and start again from its template? Its files cannot be opened and will be lost.`)) return;
    void sandbox.startFresh();
  });
  return () => {
    const { status, failure, resetting, navigating } = sandbox;
    const locked = resetting || navigating || failure !== undefined;
    return (
      <header>
        <SiteBrand />
        <SiteNav current="sandbox" sandboxHref="./" playgroundHref="./playground/?demo=serve" />
        <span id="status" role="status" aria-live="polite" data-kind={status.kind}>{status.text}</span>
        <label class="engine template-choice">
          <span class="label">Template</span>
          <select id="template" aria-label="App template" title="App template" disabled={locked} mix={choose("template")}>
            {templates.map(template => <option value={template.id} selected={sandbox.template === template.id}>{template.label}</option>)}
          </select>
        </label>
        <label class="engine">
          <span class="label">Engine</span>
          <select id="engine" aria-label="JavaScript engine" title="JavaScript engine (restarts the dev server)" disabled={locked} mix={choose("engine")}>
            {ENGINE_OPTIONS.map(([value, label]) => <option value={value} selected={value === sandbox.engine}>{label}</option>)}
          </select>
        </label>
        {sandbox.unreadable
          ? <button id="start-fresh" type="button" title="Delete the workspace that cannot be opened and start from the template" disabled={resetting || navigating} mix={startFresh}>Start fresh</button>
          : <button id="reset" type="button" aria-label="Reset template" title="Discard this workspace and restore its template" disabled={locked || !sandbox.workspaceInitialized} mix={reset}><ResetIcon /><span class="label">Reset template</span></button>}
        {failure
          ? <button id="restart" type="button" title={RELOAD_TITLES[failure]} mix={restart}>{failure === "storage" ? "Retry" : "Reload"}</button>
          : <button id="restart" type="button" aria-label="Restart" title="Restart the dev server" disabled={resetting || navigating} mix={restart}><RestartIcon /><span class="label">Restart</span></button>}
      </header>
    );
  };
}
