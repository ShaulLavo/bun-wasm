import { on, type Handle } from "@remix-run/component";
import { EditorPane } from "./editor-pane";
import type { Pane, Playground } from "./playground";
import { TerminalPane } from "./terminal-pane";
import { projectTemplates } from "./project-templates";
import { DemoBar } from "./demo-bar";
import { PreviewDock } from "./preview-dock";
import { copy } from "./showcase-copy";
import { SiteBrand, SiteNav } from "../site-header";
import { engineUnavailable, type Engine } from "../engine-loader";

type Props = { playground: Playground };

const ENGINE_OPTIONS = Object.entries(copy.engineOptions) as [Engine, string][];
const RELOAD_TITLES = { startup: "Retry playground startup", ownership: "Open the latest saved workspace", shell: copy.run.runTitle };
const PANES = ["code", "preview", "terminal"] as const satisfies readonly Pane[];
/** The phone layout in style.css starts at the same width. */
const PHONE_QUERY = "(max-width: 800px)";

function engineOption(engine: Engine, label: string, playground: Playground) {
  try {
    const unavailable = engineUnavailable(engine, playground.profileForEngine(engine));
    return { label: unavailable ? `${label} (not in this build)` : label, unavailable };
  } catch (error) { return { label: `${label} (unsupported profile)`, unavailable: String(error) }; }
}

export function App(handle: Handle<Props>) {
  const { playground } = handle.props;
  playground.addEventListener("change", () => void handle.update(), { signal: handle.signal });
  const phone = typeof matchMedia === "function" ? matchMedia(PHONE_QUERY) : undefined;
  phone?.addEventListener("change", () => void handle.update(), { signal: handle.signal });
  return () => {
    const examples = !playground.template;
    const compact = examples && phone?.matches === true;
    return (
      <>
        <Header playground={playground} compact={compact} />
        {examples ? <DemoBar playground={playground} /> : null}
        {examples ? <PaneSwitch playground={playground} compact={compact} /> : null}
        <main data-pane={examples ? playground.pane : undefined}>
          <EditorPane playground={playground} />
          <div class="output-column" data-preview={playground.dockedPreview ? "open" : undefined}>
            {playground.dockedPreview ? <PreviewDock key={playground.dockedPreview.key} playground={playground} /> : null}
            <TerminalPane playground={playground} />
          </div>
        </main>
        {examples ? <p class="compat compat-foot" title={copy.compat.title}>{copy.compat.text} <a href={copy.compat.href} target="_blank" rel="noopener">{copy.compat.linkText}</a></p> : null}
      </>
    );
  };
}

/** Opens a template workspace, keeping the chosen engine. */
function chooseProject(value: string): void {
  const next = new URL(location.href);
  next.searchParams.delete("demo");
  if (value) next.searchParams.set("template", value);
  else next.searchParams.delete("template");
  location.assign(next);
}

type HeaderProps = Props & { compact: boolean };

/**
 * On a phone in the examples workspace (`compact`) the header keeps only the wordmark, the page
 * switch and Run: the page switch already leads back to the examples, so the Project picker is
 * left out, and the Engine picker moves to the pane switch row.
 */
function Header(handle: Handle<HeaderProps>) {
  return () => {
    const { playground, compact } = handle.props;
    const { status } = playground;
    return (
      <header>
        <SiteBrand />
        <SiteNav current="playground" sandboxHref="../" playgroundHref="./" />
        <span id="status" role="status" aria-live="polite" data-kind={status.kind}>{status.text}</span>
        {compact ? null : <ProjectField playground={playground} />}
        {compact ? null : <EngineField playground={playground} />}
        {playground.unreadable ? <StartFreshButton playground={playground} /> : null}
        <RunButton playground={playground} />
      </header>
    );
  };
}

function ProjectField(handle: Handle<Props>) {
  return () => {
    const { playground } = handle.props;
    return (
      <label class="field">
        <span class="label">{copy.projectLabel}</span>
        <select id="template" aria-label={copy.projectLabel} title={copy.projectTitle} disabled={playground.locked}
          mix={on("change", (event) => chooseProject(event.currentTarget.value))}
        >
          <option value="" selected={!playground.template}>{copy.examplesOption}</option>
          {projectTemplates.map(template => <option value={template.id} selected={template.id === playground.template?.id}>{template.label}</option>)}
        </select>
      </label>
    );
  };
}

function EngineField(handle: Handle<Props>) {
  return () => {
    const { playground } = handle.props;
    return (
      <label class="field engine-field">
        <span class="label">{copy.engineLabel}</span>
        <select
          id="engine" aria-label="JavaScript engine" title={copy.engineTitle}
          disabled={playground.locked}
          mix={on("change", (event) => playground.chooseEngine(event.currentTarget.value))}
        >
          {ENGINE_OPTIONS.map(([value, label]) => {
            const option = engineOption(value, label, playground);
            return <option value={value} selected={value === playground.engine}
              disabled={option.unavailable !== null} title={option.unavailable ?? undefined}
            >{option.label}</option>;
          })}
        </select>
      </label>
    );
  };
}

/** Phones (800 px and narrower) show one pane at a time; Preview lights up while a server runs. */
function PaneSwitch(handle: Handle<HeaderProps>) {
  return () => {
    const { playground, compact } = handle.props;
    const live = playground.dockedPreview !== undefined;
    return (
      <div class="pane-switch">
        <div class="segmented" role="tablist" aria-label={copy.panes.aria}>
          {PANES.map(pane => (
            <button key={pane} type="button" role="tab" aria-selected={playground.pane === pane}
              disabled={pane === "preview" && !live}
              mix={on("click", () => playground.setPane(pane))}
            >
              {pane === "preview" && live ? <span class="live" title={copy.panes.previewLive} aria-hidden="true" /> : null}
              {copy.panes[pane]}
            </button>
          ))}
        </div>
        {compact ? <EngineField playground={playground} /> : null}
      </div>
    );
  };
}

function StartFreshButton(handle: Handle<Props>) {
  const click = on<HTMLButtonElement>("click", () => {
    if (!confirm("Delete this browser's saved playground workspace and start a new one? Its files cannot be opened and will be lost.")) return;
    void handle.props.playground.startFresh();
  });
  return () => <button id="start-fresh" type="button" title="Delete the workspace that cannot be opened and start a new one" disabled={handle.props.playground.startingFresh} mix={click}>Start fresh</button>;
}

/** Run when idle; the same button becomes Stop while a command runs, so nothing shifts. */
function RunButton(handle: Handle<Props>) {
  const click = on<HTMLButtonElement>("click", () => {
    const { playground } = handle.props;
    if (playground.failure) location.reload();
    else if (playground.busy) playground.stop();
    else if (playground.ready) void playground.run().catch(playground.report);
  });
  return () => {
    const { failure, canRun, busy } = handle.props.playground;
    if (failure) return <button id="run" type="button" data-state="reload" title={RELOAD_TITLES[failure]} mix={click}>Reload</button>;
    if (busy) return <button id="run" type="button" data-state="stop" title={copy.run.stopTitle} mix={click}>{copy.run.stop}</button>;
    return <button id="run" type="button" data-state="run" title={copy.run.runTitle} disabled={!canRun} mix={click}>{copy.run.run}</button>;
  };
}
