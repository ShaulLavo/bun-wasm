import type { ScopedTransport } from "./transport";
import { ENGINES, isEngine } from "../../web/src/engine-loader";
import type { Framework } from "./catalog";
import type { PlaygroundProfile } from "../../web/src/playground/program-profile";
interface Playground {
  profile: PlaygroundProfile;
  shell: { running: boolean; lastExit: number; submit(text: string): Promise<void>; input(text: string): void };
  previews: { readonly ready: Promise<"ready" | "unsupported" | "failed">; serves(port: number): boolean; url(port: number): string };
  editor: { open(path: string): Promise<void>; save(): Promise<void>; view: { state: { doc: { toString(): string; length: number } }; dispatch(change: { changes: { from: number; to: number; insert: string } }): void } };
  term: { write(text: string, callback: () => void): void; buffer: { active: { length: number; getLine(index: number): { isWrapped: boolean; translateToString(trim: boolean): string } | undefined } } };
}
declare const playground: Playground;
type PreviewState = { status: "pending" | "ready" } | { status: "failed"; error: unknown };
declare global { var __goalsPreview: PreviewState | undefined; var __goalsCommand: { token: string; done: boolean; code: number | null; error: string | null } | undefined; }
function expression<A, R>(operation: (input: A) => R, input: A): string { return `(${operation.toString()})(${JSON.stringify(input)})`; }
/** An observation that was never accepted before its deadline, as distinct from one that failed. */
export class ObservationTimeout extends Error {}
export async function until<T>(operation: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (true) {
    const value = await operation();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new ObservationTimeout(`Timed out after ${timeoutMs} ms; last observation: ${JSON.stringify(value)}`);
    await Bun.sleep(Math.min(100, end - Date.now()));
  }
}
function readyState(): { ready: boolean; status: string; engine: string | null; agent: string; observedEngine: string | null; profile: PlaygroundProfile | null } {
  const control = document.querySelector("#engine");
  const observedEngine = control && "value" in control && typeof control.value === "string" ? control.value : null;
  return { observedEngine, ready: typeof playground !== "undefined", profile: typeof playground === "undefined" ? null : playground.profile, status: document.querySelector("#status")?.textContent ?? "", engine: new URL(location.href).searchParams.get("engine"), agent: navigator.userAgent };
}
export async function ready(transport: ScopedTransport, engine: string, timeoutMs: number, profile: PlaygroundProfile = "split"): Promise<unknown> {
  if (!isEngine(engine)) throw new Error(`Engine is not registered: ${engine}`);
  const state = await until(() => transport.evaluate<ReturnType<typeof readyState>>(expression(readyState, undefined)), value => value.ready || /failed|missing/i.test(value.status), timeoutMs);
  const label = ENGINES[engine].name;
  if (!state.status.includes(label)) throw new Error(`Wrong running engine status: ${state.status}`);
  if (!state.ready || !/ready/.test(state.status) || state.engine !== engine || state.observedEngine !== engine) throw new Error(`Playground not ready for ${engine}: ${JSON.stringify(state)}`);
  if (state.profile !== profile) throw new Error(`Wrong running program profile: expected ${profile}, observed ${state.profile}`);
  return state;
}
function transcript(): Promise<string> {
  function logicalLines(): string {
    const buffer = playground.term.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index);
      return (index && !line?.isWrapped ? "\n" : "") + (line?.translateToString(true) ?? "");
    });
    return lines.join("").trimEnd();
  }
  return new Promise(resolve => playground.term.write("", () => resolve(logicalLines())));
}
export async function terminal(transport: ScopedTransport): Promise<string> {
  await transport.useHost();
  return transport.evaluate<string>(expression(transcript, undefined));
}
function launch(text: string): string {
  const current: NonNullable<typeof globalThis.__goalsCommand> = { token: crypto.randomUUID(), done: false, code: null, error: null };
  globalThis.__goalsCommand = current;
  void playground.shell.submit(text).then(() => { current.code = playground.shell.lastExit; current.done = true; }, error => { current.error = String(error); current.done = true; });
  return current.token;
}
function shellState(token: string): { done: boolean; code: number | null; error: string | null } {
  const current = globalThis.__goalsCommand;
  if (!current || current.token !== token) throw new Error("Command token differs");
  return { done: current.done, code: current.code, error: current.error };
}
export interface ForegroundObservation {
  readonly expression: string;
  dispatched(at: number): void;
  pending(value: unknown): Promise<boolean>;
}
/** Runs one foreground command to its exit, whatever its code. Throws ObservationTimeout when it is still running at the deadline. */
export async function foreground(transport: ScopedTransport, text: string, timeoutMs: number, observation?: ForegroundObservation): Promise<ReturnType<typeof shellState>> {
  await transport.useHost();
  const dispatchedAt = observation ? Date.now() : 0;
  const token = await transport.evaluate<string>(expression(launch, text));
  if (!observation) return until(() => transport.evaluate<ReturnType<typeof shellState>>(expression(shellState, token)), state => state.done, timeoutMs);
  observation.dispatched(dispatchedAt);
  const poll = expression(shellState, token);
  const observedPoll = `(() => { const state = ${poll}; let observation = null; if (!state.done) { try { observation = ${observation.expression}; } catch (error) { observation = { unavailable: String(error) }; } } return { state, observation }; })()`;
  return until(async () => {
    const value = await transport.evaluate<{ state: ReturnType<typeof shellState>; observation: unknown }>(observedPoll);
    if (!value.state.done && await observation.pending(value.observation)) return transport.evaluate<ReturnType<typeof shellState>>(poll);
    return value.state;
  }, state => state.done, timeoutMs);
}
export async function command(transport: ScopedTransport, text: string, timeoutMs: number, observation?: ForegroundObservation): Promise<unknown> {
  const result = await foreground(transport, text, timeoutMs, observation);
  const output = await terminal(transport);
  if (result.code !== 0 || result.error) throw new Error(`${text} exited ${result.code}: ${result.error ?? output.slice(-6000)}`);
  return { ...result, output };
}
function listener(port: number): { listening: boolean; running: boolean; url: string | null } {
  if (typeof playground === "undefined") return { listening: false, running: false, url: null };
  const listening = playground.previews.serves(port);
  return { listening, running: playground.shell.running, url: listening ? playground.previews.url(port) : null };
}
function previewReady(refresh = false): boolean {
  if (refresh) globalThis.__goalsPreview = undefined;
  if (!globalThis.__goalsPreview) {
    const pending: PreviewState = { status: "pending" };
    globalThis.__goalsPreview = pending;
    void playground.previews.ready.then(state => {
      if (globalThis.__goalsPreview !== pending) return;
      globalThis.__goalsPreview = state === "ready" ? { status: "ready" } : { status: "failed", error: new Error(`Preview transport is ${state}`) };
    }, error => { if (globalThis.__goalsPreview === pending) globalThis.__goalsPreview = { status: "failed", error }; });
  }
  const state = globalThis.__goalsPreview;
  if (state.status === "failed") throw state.error;
  return state.status === "ready";
}
type PreviewAttempt = { status: "pass" } | { status: "fail"; error: unknown };
function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("Preview binding did not settle before the phase deadline");
  return value;
}
async function currentPreview(transport: ScopedTransport, deadline: number, port: number): Promise<string> {
  await transport.useHost();
  while (true) {
    const before = await until(() => transport.evaluate<ReturnType<typeof listener>>(expression(listener, port)), value => value.listening || !value.running, remaining(deadline));
    if (!before.url) throw new Error(`Server exited without listening: ${await terminal(transport)}`);
    await transport.evaluate<boolean>(expression(previewReady, true));
    let activation: PreviewAttempt = { status: "pass" };
    try { await until(() => transport.evaluate<boolean>(expression(previewReady, false)), value => value, remaining(deadline)); }
    catch (error) { activation = { status: "fail", error }; }
    const after = await transport.evaluate<ReturnType<typeof listener>>(expression(listener, port));
    if (before.url !== after.url && (after.listening || after.running)) continue;
    if (activation.status === "fail") throw activation.error;
    if (!after.url) throw new Error("Preview listener stopped during activation");
    return after.url;
  }
}
export async function start(transport: ScopedTransport, text: string, timeoutMs: number, port = 5173): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  await transport.useHost();
  await transport.evaluate<boolean>(expression(previewReady, true));
  const before = await transport.evaluate<ReturnType<typeof listener>>(expression(listener, port));
  if (before.running || before.listening) throw new Error("Cannot start with an existing foreground or listener");
  const token = await transport.evaluate<string>(expression(launch, text));
  const result = await until(async () => ({ ...await transport.evaluate<ReturnType<typeof listener>>(expression(listener, port)), command: await transport.evaluate<ReturnType<typeof shellState>>(expression(shellState, token)) }), value => value.listening || value.command.done, remaining(deadline));
  if (!result.url) throw new Error(`Server exited without listening: ${await terminal(transport)}`);
  return currentPreview(transport, deadline, port);
}
export async function openPreview(transport: ScopedTransport, timeoutMs: number, port = 5173): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const url = await currentPreview(transport, deadline, port);
    let navigation: PreviewAttempt = { status: "pass" };
    try { await transport.openPreview(url); }
    catch (error) { navigation = { status: "fail", error }; }
    await transport.useHost();
    const after = await transport.evaluate<ReturnType<typeof listener>>(expression(listener, port));
    if (url !== after.url && (after.listening || after.running)) continue;
    if (navigation.status === "fail") throw navigation.error;
    if (!after.url) throw new Error("Preview listener stopped during navigation");
    await transport.usePreview();
    return after.url;
  }
}
function stop(): void {
  if (typeof playground === "undefined") return;
  if (playground.shell.running) playground.shell.input("\x03");
  if (playground.shell.running) playground.shell.input("\x03");
}
export async function stopServer(transport: ScopedTransport, timeoutMs: number, port = 5173): Promise<void> {
  await transport.useHost();
  await transport.evaluate(expression(stop, undefined));
  await until(() => transport.evaluate<ReturnType<typeof listener>>(expression(listener, port)), value => !value.running && !value.listening, timeoutMs);
}
function rendered(input: { selector: string; text: string }): { text: string; matched: boolean } {
  const text = document.querySelector(input.selector)?.textContent ?? "";
  return { text, matched: text.trim() === input.text };
}
export async function render(transport: ScopedTransport, framework: Framework, text: string, timeoutMs: number): Promise<unknown> {
  return until(() => transport.evaluate<ReturnType<typeof rendered>>(expression(rendered, { selector: framework.selector, text }), { observation: true }), value => value.matched, timeoutMs);
}
function click(input: { button: string; clicked: string }): { before: string; clicked: boolean } {
  const before = document.querySelector(input.clicked)?.textContent?.trim() ?? "";
  const button = document.querySelector<HTMLButtonElement>(input.button);
  if (!button || button.disabled) return { before, clicked: false };
  if (!/\b0\b/.test(before)) throw new Error(`Counter must start at zero, received ${before}`);
  button.click();
  return { before, clicked: true };
}
export async function checkClick(transport: ScopedTransport, framework: Framework, timeoutMs: number): Promise<unknown> {
  if (transport.nativeClick) return transport.nativeClick(framework.button, framework.clicked, timeoutMs);
  const before = await until(() => transport.evaluate<ReturnType<typeof click>>(expression(click, framework)), value => value.clicked, timeoutMs);
  const after = await until(() => transport.evaluate<string>(`document.querySelector(${JSON.stringify(framework.clicked)})?.textContent?.trim() ?? ''`), value => value === before.before.replace(/\b0\b/, "1"), timeoutMs);
  return { before: before.before, after };
}
async function saveEdit(input: { source: string; original: string; edited: string }): Promise<void> {
  await playground.editor.open(`/home/user/${input.source}`);
  const view = playground.editor.view;
  const source = view.state.doc.toString();
  if (!source.includes(input.original) || source.includes(input.edited)) throw new Error(`Missing unique source marker in ${input.source}`);
  view.dispatch({ changes: { from: 0, to: source.length, insert: source.replace(input.original, input.edited) } });
  await playground.editor.save();
}
export async function edit(transport: ScopedTransport, framework: Framework, timeoutMs: number): Promise<unknown> {
  const updated = `${framework.text} hot updated`;
  const identity = crypto.randomUUID();
  const state = await transport.evaluate<string>(`globalThis.__goalsIdentity = ${JSON.stringify(identity)}; String(document.querySelector(${JSON.stringify(framework.clicked)})?.textContent)`);
  await transport.useHost();
  await transport.evaluate(expression(saveEdit, { source: framework.source, original: framework.text, edited: updated }));
  await transport.usePreview();
  const result = await render(transport, framework, updated, timeoutMs);
  const retained = await transport.evaluate<boolean>(`globalThis.__goalsIdentity === ${JSON.stringify(identity)}`, { observation: true });
  return { updated, before: state, sameDocument: retained, result, manualNavigations: 0 };
}
