import type { Transport } from "./transport";
import type { Framework } from "./catalog";
interface Playground {
  shell: { running: boolean; lastExit: number; submit(text: string): Promise<void>; input(text: string): void };
  previews: { serves(port: number): boolean; url(port: number): string };
  editor: { open(path: string): Promise<void>; save(): Promise<void>; view: { state: { doc: { toString(): string; length: number } }; dispatch(change: { changes: { from: number; to: number; insert: string } }): void } };
  term: { write(text: string, callback: () => void): void; buffer: { active: { length: number; getLine(index: number): { translateToString(trim: boolean): string } | undefined } } };
}
declare const playground: Playground;
export function expression<A, R>(operation: (input: A) => R, input: A): string { return `(${operation.toString()})(${JSON.stringify(input)})`; }
export async function until<T>(operation: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (true) {
    const value = await operation();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Timed out after ${timeoutMs} ms; last observation: ${JSON.stringify(value)}`);
    await Bun.sleep(Math.min(100, end - Date.now()));
  }
}
function readyState(): { ready: boolean; status: string; engine: string | null; agent: string } {
  return { ready: typeof playground !== "undefined", status: document.querySelector("#status")?.textContent ?? "", engine: new URL(location.href).searchParams.get("engine"), agent: navigator.userAgent };
}
export async function ready(transport: Transport, engine: string, timeoutMs: number): Promise<unknown> {
  const state = await until(() => transport.evaluate<ReturnType<typeof readyState>>(expression(readyState, undefined)), value => value.ready || /failed|missing/i.test(value.status), timeoutMs);
  if (!state.ready || !/ready/.test(state.status) || state.engine !== engine) throw new Error(`Playground not ready for ${engine}: ${JSON.stringify(state)}`);
  return state;
}
function transcript(): Promise<string> {
  return new Promise(resolve => playground.term.write("", () => {
    const buffer = playground.term.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "");
    resolve(lines.join("\n").trimEnd());
  }));
}
export async function terminal(transport: Transport): Promise<string> {
  await transport.useHost();
  return transport.evaluate<string>(expression(transcript, undefined));
}
function launch(text: string): void { void playground.shell.submit(text); }
function shellState(): { running: boolean; code: number } { return { running: playground.shell.running, code: playground.shell.lastExit }; }
export async function command(transport: Transport, text: string, timeoutMs: number): Promise<unknown> {
  await transport.useHost();
  await transport.evaluate(expression(launch, text));
  const result = await until(() => transport.evaluate<ReturnType<typeof shellState>>(expression(shellState, undefined)), state => !state.running, timeoutMs);
  const output = await terminal(transport);
  if (result.code !== 0) throw new Error(`${text} exited ${result.code}: ${output.slice(-6000)}`);
  return { ...result, output };
}
function listener(): { listening: boolean; running: boolean; url: string | null } {
  if (typeof playground === "undefined") return { listening: false, running: false, url: null };
  const listening = playground.previews.serves(5173);
  return { listening, running: playground.shell.running, url: listening ? playground.previews.url(5173) : null };
}
export async function start(transport: Transport, text: string, timeoutMs: number): Promise<string> {
  await transport.useHost();
  await transport.evaluate(expression(launch, text));
  const result = await until(() => transport.evaluate<ReturnType<typeof listener>>(expression(listener, undefined)), value => value.listening || !value.running, timeoutMs);
  if (!result.url) throw new Error(`Server exited without listening: ${await terminal(transport)}`);
  return result.url;
}
function stop(): void {
  if (typeof playground === "undefined") return;
  if (playground.shell.running) playground.shell.input("\x03");
  if (playground.shell.running) playground.shell.input("\x03");
}
export async function stopServer(transport: Transport, timeoutMs: number): Promise<void> {
  await transport.useHost();
  await transport.evaluate(expression(stop, undefined));
  await until(() => transport.evaluate<ReturnType<typeof listener>>(expression(listener, undefined)), value => !value.running && !value.listening, timeoutMs);
}
function rendered(input: { selector: string; text: string }): { text: string; matched: boolean } {
  const text = document.querySelector(input.selector)?.textContent ?? "";
  return { text, matched: text.includes(input.text) };
}
export async function render(transport: Transport, framework: Framework, text: string, timeoutMs: number): Promise<unknown> {
  return until(() => transport.evaluate<ReturnType<typeof rendered>>(expression(rendered, { selector: framework.selector, text })), value => value.matched, timeoutMs);
}
function click(input: { button: string; clicked: string }): { before: string; clicked: boolean } {
  const before = document.querySelector(input.clicked)?.textContent?.trim() ?? "";
  const button = document.querySelector<HTMLButtonElement>(input.button);
  if (!button || button.disabled) return { before, clicked: false };
  button.click();
  return { before, clicked: true };
}
export async function checkClick(transport: Transport, framework: Framework, timeoutMs: number): Promise<unknown> {
  const before = await until(() => transport.evaluate<ReturnType<typeof click>>(expression(click, framework)), value => value.clicked, timeoutMs);
  const after = await until(() => transport.evaluate<string>(`document.querySelector(${JSON.stringify(framework.clicked)})?.textContent?.trim() ?? ''`), value => value !== before.before && /1/.test(value), timeoutMs);
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
export async function edit(transport: Transport, framework: Framework, timeoutMs: number): Promise<unknown> {
  const updated = `${framework.text} hot updated`;
  const identity = crypto.randomUUID();
  const state = await transport.evaluate<string>(`globalThis.__goalsIdentity = ${JSON.stringify(identity)}; String(document.querySelector(${JSON.stringify(framework.clicked)})?.textContent)`);
  await transport.useHost();
  await transport.evaluate(expression(saveEdit, { source: framework.source, original: framework.text, edited: updated }));
  await transport.usePreview();
  const result = await render(transport, framework, updated, timeoutMs);
  const retained = await transport.evaluate<boolean>(`globalThis.__goalsIdentity === ${JSON.stringify(identity)}`);
  return { updated, before: state, sameDocument: retained, result, manualNavigations: 0 };
}
