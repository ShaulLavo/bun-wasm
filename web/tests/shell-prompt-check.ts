import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import type { Terminal } from "@xterm/xterm";
import type { BrowserSession } from "bash-web/session";
import type { Runtime } from "waffle";
import { importPromptRepository, promptRepositoryFixtures, type PromptRepositoryFixture } from "./shell-prompt-fixture";

type ReadFile = Runtime["filesystem"]["readFile"];
type ObservedPlayground = {
  readonly runtime: Runtime;
  readonly fs: Runtime["filesystem"];
  readonly shell: BrowserSession;
  readonly term: Terminal;
};

export interface PromptReadBarrier {
  readonly entered: Promise<void>;
  readonly finished: Promise<void>;
  readonly blocked: boolean;
  release(): void;
  restore(): void;
}

/** Self-contained so the browser installs exactly the implementation exercised by source tests. */
export function armPromptReadBarrier(filesystem: Pick<Runtime["filesystem"], "readFile">, path: string): PromptReadBarrier {
  const descriptor = Object.getOwnPropertyDescriptor(filesystem, "readFile");
  const original = filesystem.readFile;
  let resolveEntered!: () => void;
  let resolveReleased!: () => void;
  let resolveFinished!: () => void;
  let blocked = false;
  let restored = false;
  const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
  const released = new Promise<void>(resolve => { resolveReleased = resolve; });
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const intercepted: ReadFile = function(this: Runtime["filesystem"], ...args) {
    if (restored || args[0] !== path) return original.apply(this, args);
    blocked = true;
    resolveEntered();
    return released.then(() => original.apply(this, args)).finally(() => {
      blocked = false;
      resolveFinished();
    });
  };
  Object.defineProperty(filesystem, "readFile", { configurable: true, writable: true, value: intercepted });
  return {
    entered, finished,
    get blocked() { return blocked; },
    release: resolveReleased,
    restore() {
      if (restored) return;
      restored = true;
      if (descriptor) Object.defineProperty(filesystem, "readFile", descriptor);
      else Reflect.deleteProperty(filesystem, "readFile");
      resolveReleased();
    },
  };
}

/** The fixture budget is temporary; the page's production defaults never change. */
export async function installPromptReadBudget(filesystem: Pick<Runtime["filesystem"], "readFile" | "writeFile" | "remove" | "mkdirp">): Promise<() => Promise<void>> {
  const path = "/home/user/.config/bash-web/prompt.json";
  const previous = await filesystem.readFile(path);
  const restore = async () => {
    await filesystem.remove(path);
    if (previous !== undefined) await filesystem.writeFile(path, previous);
  };
  await filesystem.mkdirp("/home/user/.config/bash-web");
  try {
    await filesystem.remove(path);
    await filesystem.writeFile(path, '{"backgroundMs":60000}');
  } catch (error) {
    try { await restore(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Prompt budget installation and rollback failed", { cause: error }); }
    throw error;
  }
  return restore;
}

type Cell = { readonly text: string; readonly fg: number; readonly rgb: boolean; readonly bold: boolean };
type Row = { readonly text: string; readonly wrapped: boolean; readonly cells: readonly Cell[] };
export interface PromptSnapshot {
  readonly rows: readonly Row[];
  readonly generation: string;
  readonly cursorX: number;
  readonly cursorRow: number;
  readonly cols: number;
}

/** This runs in the page, reads public xterm cells, and flushes every queued write first. */
async function snapshotPrompt(): Promise<PromptSnapshot> {
  const { term, shell }: ObservedPlayground = Reflect.get(globalThis, "playground");
  await new Promise<void>(resolve => term.write("", resolve));
  const buffer = term.buffer.active;
  const rows = Array.from({ length: buffer.length }, (_, index) => {
    const line = buffer.getLine(index);
    const cells = Array.from({ length: term.cols }, (_, column) => {
      const cell = line?.getCell(column);
      return { text: cell?.getChars() ?? "", fg: cell?.getFgColor() ?? -1, rgb: cell?.isFgRGB() ?? false, bold: Boolean(cell?.isBold()) };
    });
    return { text: line?.translateToString(true) ?? "", wrapped: line?.isWrapped ?? false, cells };
  });
  return { rows, cursorX: buffer.cursorX, cursorRow: buffer.baseY + buffer.cursorY, cols: term.cols, generation: String(shell.lastPrompt?.generation) };
}

function activePrompt(snapshot: PromptSnapshot): string[] {
  const lines: string[] = [];
  for (const row of snapshot.rows.slice(0, snapshot.cursorRow + 1)) {
    if (row.wrapped && lines.length) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  const character = lines.findLastIndex(line => line.includes("❯"));
  if (character <= 0) throw new Error("The provider must draw a directory line and a character line");
  return lines.slice(character - 1);
}

export function assertActivePromptWrap(snapshot: PromptSnapshot): void {
  const rows = snapshot.rows.slice(0, snapshot.cursorRow + 1);
  let character = rows.findLastIndex(row => row.text.includes("❯"));
  while (character > 0 && rows[character]?.wrapped) character--;
  let directory = character - 1;
  while (directory > 0 && rows[directory]?.wrapped) directory--;
  assert.ok(directory >= 0, "Active prompt has a directory and character line");
  assert.ok(rows.slice(directory + 1).some(row => row.wrapped), "Active narrow prompt actually soft-wraps");
}

export function assertPreservedDraft(before: PromptSnapshot, after: PromptSnapshot): void {
  assert.equal(after.generation, before.generation, "Redraw belongs to the same acknowledged prompt generation");
  assert.deepEqual(activePrompt(after).slice(1), activePrompt(before).slice(1), "Redraw preserves every draft line");
  assert.equal(after.cursorX, before.cursorX, "Redraw preserves the caret column");
  assertCaretAtEnd(after);
  assert.equal(after.rows.filter(row => row.text.includes("❯")).length, before.rows.filter(row => row.text.includes("❯")).length, "Redraw does not duplicate prompt rows");
}

function assertCaretAtEnd(snapshot: PromptSnapshot): void {
  const row = snapshot.rows[snapshot.cursorRow];
  assert.ok(row, "Caret row exists");
  const suffix = row.cells.slice(snapshot.cursorX).map(cell => cell.text).join("").trim();
  assert.equal(suffix, "", "Caret remains at the end of the typed draft");
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const playground: ObservedPlayground | undefined = Reflect.get(globalThis, "playground");
    const shell = playground?.shell;
    return shell?.state === "ready" && shell.lastPrompt !== undefined && !shell.running;
  });
}

async function submit(page: Page, command: string): Promise<void> {
  await page.evaluate(async text => {
    const { shell }: ObservedPlayground = Reflect.get(globalThis, "playground");
    await shell.submit(text);
    if (shell.lastExit !== 0) throw new Error(`Prompt fixture command exited ${shell.lastExit}: ${text}`);
  }, command);
  await ready(page);
}

function characterCell(snapshot: PromptSnapshot): Cell {
  const row = snapshot.rows.findLast(row => row.text.includes("❯"));
  const cell = row?.cells.find(cell => cell.text === "❯");
  assert.ok(cell, "Prompt character cell exists");
  return cell;
}

export async function checkPrompt(page: Page, browser: string, engine: string) {
  assert.notEqual(new URL(page.url()).searchParams.get("prompt"), "off", "Prompt checks require the default provider arm");
  await ready(page);
  const initial = await page.evaluate(snapshotPrompt);
  assert.match(activePrompt(initial)[0] ?? "", /~/, "First prompt shows the home directory");
  const firstCharacter = characterCell(initial);
  assert.deepEqual(firstCharacter, { text: "❯", fg: 2, rgb: false, bold: true }, "Default character is ANSI green and bold");
  await submit(page, "mkdir -p app && cd app");
  assert.match(activePrompt(await page.evaluate(snapshotPrompt))[0] ?? "", /app/, "Prompt follows cd");
  await page.evaluate(async () => {
    const { shell }: ObservedPlayground = Reflect.get(globalThis, "playground");
    await shell.submit("false");
    if (shell.lastExit !== 1) throw new Error("false must exit with status 1");
  });
  const failed = characterCell(await page.evaluate(snapshotPrompt));
  await submit(page, "true");
  const passed = characterCell(await page.evaluate(snapshotPrompt));
  assert.deepEqual(failed, { text: "❯", fg: 1, rgb: false, bold: true }, "Failure character is ANSI red and bold");
  assert.deepEqual(passed, firstCharacter, "Success restores the default character color");
  await submit(page, "cd /home/user");
  const repositories = await promptRepositoryFixtures();
  const modified = repositories.find(fixture => fixture.step === "modified");
  assert.ok(modified, "Qualified fixture includes a modified tracked file");
  const late = await pendingUpdate(page, modified, "draft", "echo typed", false);
  const paste = await pendingUpdate(page, modified, "paste", "printf first\nprintf second", false);
  const interrupted = await pendingUpdate(page, modified, "interrupt", "echo cancelled", true);
  const narrow = await checkNarrowPrompt(page, modified);
  const git = await checkGitMarkers(page, repositories);
  const config = await checkConfig(page);
  const versions = await checkVersions(page);
  await submit(page, "cd /home/user");
  console.log(`ok ${browser}/${engine}: default prompt and controlled same-turn redraw`);
  return { mode: "on", browser, engine, initial, late, paste, interrupted, narrow, git, config, versions };
}

export async function prepareRepository(page: Pick<Page, "evaluate">, name: string, fixture: PromptRepositoryFixture): Promise<string> {
  const root = `/home/user/prompt-${name}`;
  // Each import has a fresh root, so the provider must read the actual tracked bytes.
  await page.evaluate(`(${importPromptRepository.toString()})(globalThis.playground.fs, ${JSON.stringify(root)}, ${JSON.stringify(fixture.files)})`);
  return root;
}

/** Delay the original lazy status source, without changing bytes or a frozen runtime capability. */
export function deferredPromptSource() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const pending = new Set<Promise<void>>();
  const urls: string[] = [];
  const errors: unknown[] = [];
  function hold(url: string, proceed: () => Promise<void>): Promise<void> {
    urls.push(url);
    entered.resolve();
    const request = released.promise.then(proceed);
    pending.add(request);
    void request.then(() => pending.delete(request), error => { errors.push(error); pending.delete(request); });
    return request;
  }
  async function drain(): Promise<void> {
    released.resolve();
    await Promise.allSettled(Array.from(pending));
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Prompt source transport failed");
  }
  return { entered: entered.promise, urls, hold, release: () => released.resolve(), drain };
}

async function installStatusBarrier(page: Page) {
  const source = deferredPromptSource();
  const pattern = /\/chunks\/status-[^/?]+\.js(?:\?.*)?$/;
  const handler = (route: Route) => source.hold(route.request().url(), () => route.continue());
  await page.route(pattern, handler);
  async function restore(): Promise<void> {
    source.release();
    await page.unroute(pattern, handler);
    await source.drain();
  }
  async function release(): Promise<void> {
    assert.ok(source.urls.length, "A real status source request must be held");
    source.release();
    await source.drain();
    // Wait for the same native module import to settle, not a substitute status result.
    await page.evaluate(url => import(url).then(() => undefined), source.urls[0]!);
  }
  return { ...source, release, restore };
}

async function installPromptCapture(page: Page): Promise<void> {
  await page.evaluate(`globalThis.promptCapture = ${snapshotPrompt.toString()};
globalThis.promptLines = ${activePrompt.toString()};`);
}

async function updatedStatus(page: Page, generation: string): Promise<void> {
  await page.waitForFunction(async expected => {
    const capture: typeof snapshotPrompt = Reflect.get(globalThis, "promptCapture");
    const lines: typeof activePrompt = Reflect.get(globalThis, "promptLines");
    const snapshot = await capture();
    if (snapshot.generation !== expected) throw new Error("Status update escaped its prompt turn");
    return /\[[^\]]*!/.test(lines(snapshot)[0] ?? "");
  }, generation);
}

export function promptReadBudgetSetup(): string {
  return `(async () => {
    globalThis.restorePromptReadBudget = await (${installPromptReadBudget.toString()})(globalThis.playground.fs);
  })()`;
}

/** Always attempt every cleanup step. Keep the first failure as the cause and first error. */
export async function withPromptFixture<T>(action: () => Promise<T>, cleanup: readonly (() => Promise<void>)[]): Promise<T> {
  const errors: unknown[] = [];
  const result: { kind: "success"; value: T } | { kind: "failure"; error: unknown } = await action().then(
    value => ({ kind: "success", value }),
    (error: unknown) => ({ kind: "failure", error }),
  );
  if (result.kind === "failure") errors.push(result.error);
  for (const clean of cleanup) {
    try { await clean(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Prompt fixture failed; see cause for the first failure", { cause: errors[0] });
  if (result.kind === "failure") throw result.error;
  return result.value;
}

async function pendingUpdate(page: Page, fixture: PromptRepositoryFixture, name: string, draft: string, interrupt: boolean, columns?: number) {
  const barrier = await installStatusBarrier(page);
  return withPromptFixture(async () => {
    // Each arm has a fresh realm so the real lazy status module is not already evaluated.
    await page.goto(page.url());
    await ready(page);
    if (columns) await page.evaluate(cols => Reflect.get(globalThis, "playground").term.resize(cols, 24), columns);
    await page.evaluate(promptReadBudgetSetup());
    const root = await prepareRepository(page, name, fixture);
    await installPromptCapture(page);
    return exercisePendingUpdate(page, root, draft, interrupt, barrier);
  }, [barrier.restore, () => restorePendingFixture(page), () => submit(page, "cd /home/user")]);
}

/** Self-contained: restore the method, drain admitted reads, restore config, then forget globals. */
export async function restorePromptFixture(): Promise<void> {
  const barrier: PromptReadBarrier | undefined = Reflect.get(globalThis, "promptReadBarrier");
  const restoreBudget: (() => Promise<void>) | undefined = Reflect.get(globalThis, "restorePromptReadBudget");
  const errors: unknown[] = [];
  try { barrier?.restore(); }
  catch (error) { errors.push(error); }
  try { barrier?.release(); }
  catch (error) { errors.push(error); }
  try { if (barrier?.blocked) await barrier.finished; }
  catch (error) { errors.push(error); }
  try { await restoreBudget?.(); }
  catch (error) { errors.push(error); }
  for (const key of ["promptReadBarrier", "promptCapture", "promptLines", "restorePromptReadBudget"]) Reflect.deleteProperty(globalThis, key);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Prompt fixture cleanup failed", { cause: errors[0] });
}

export async function restorePendingFixture(page: Pick<Page, "evaluate">): Promise<void> {
  await page.evaluate(restorePromptFixture);
}

async function exercisePendingUpdate(page: Page, root: string, draft: string, interrupt: boolean, barrier: Awaited<ReturnType<typeof installStatusBarrier>>) {
  const submission = submit(page, `cd ${root}`);
  void submission.catch(() => {});
  // Require an actual held dependency request and the initial real prompt before typing.
  await Promise.all([barrier.entered, submission]);
  await page.evaluate(text => {
    const { shell }: ObservedPlayground = Reflect.get(globalThis, "playground");
    shell.input(`\x1b[200~${text}\x1b[201~`);
  }, draft);
  await page.waitForFunction(text => {
    const { term }: ObservedPlayground = Reflect.get(globalThis, "playground");
    const buffer = term.buffer.active;
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).endsWith(text);
  }, draft.split("\n").at(-1) ?? "");
  const before = await page.evaluate(snapshotPrompt);
  assertCaretAtEnd(before);
  assert.doesNotMatch(activePrompt(before)[0] ?? "", /\[[^\]]*!/, "The real status source remains held while the draft is typed");
  if (interrupt) return interruptPendingUpdate(page, before, barrier);
  await barrier.release();
  await updatedStatus(page, before.generation);
  const after = await page.evaluate(snapshotPrompt);
  assertPreservedDraft(before, after);
  await submit(page, "cd /home/user");
  return { kind: "redraw", control: "held real status module, frozen filesystem unchanged", sourceRequests: barrier.urls.slice(), before, after };
}

async function interruptPendingUpdate(page: Page, before: PromptSnapshot, barrier: Awaited<ReturnType<typeof installStatusBarrier>>) {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await page.waitForFunction(previous => {
    const { shell }: ObservedPlayground = Reflect.get(globalThis, "playground");
    return String(shell.lastPrompt?.generation) !== previous && !shell.running;
  }, before.generation);
  // Leave the repository so the new turn cannot legitimately publish the old status marker.
  await submit(page, "cd /home/user");
  const fresh = await page.evaluate(snapshotPrompt);
  await barrier.release();
  const after = await page.evaluate(snapshotPrompt);
  assert.deepEqual(activePrompt(after), activePrompt(fresh), "Cancelled status source never redraws the new prompt");
  assert.equal(after.generation, fresh.generation);
  return { kind: "interrupt", control: "held real status module, frozen filesystem unchanged", sourceRequests: barrier.urls.slice(), before, fresh, after };
}

async function checkNarrowPrompt(page: Page, fixture: PromptRepositoryFixture) {
  const geometry = await page.evaluate(() => {
    const { term }: ObservedPlayground = Reflect.get(globalThis, "playground");
    const dimensions = { cols: term.cols, rows: term.rows };
    term.resize(32, 24);
    return dimensions;
  });
  try {
    const result = await pendingUpdate(page, fixture, "narrow-repository-that-wraps-the-first-line", "echo narrow", false, 32);
    assert.equal(result.kind, "redraw");
    assertActivePromptWrap(result.before);
    assert.match(activePrompt(result.before)[0] ?? "", /🥟/, "Width control includes the default Bun emoji");
    return result;
  } finally {
    await page.evaluate(size => {
      const { term }: ObservedPlayground = Reflect.get(globalThis, "playground");
      term.resize(size.cols, size.rows);
    }, geometry);
  }
}

async function writePromptConfig(page: Page, text: string): Promise<void> {
  await page.evaluate(async contents => {
    const { fs }: ObservedPlayground = Reflect.get(globalThis, "playground");
    const path = "/home/user/.config/bash-web/prompt.json";
    await fs.mkdirp("/home/user/.config/bash-web");
    await fs.remove(path);
    await fs.writeFile(path, contents);
  }, text);
  await submit(page, "true");
}

async function checkConfig(page: Page) {
  const warnings: string[] = [];
  const observe = (message: { type(): string; text(): string }) => {
    if (message.type() === "warning" && message.text().includes("[prompt]")) warnings.push(message.text());
  };
  page.on("console", observe);
  try { return await exerciseConfig(page, warnings); }
  finally {
    page.off("console", observe);
    await page.evaluate(async () => {
      const { fs }: ObservedPlayground = Reflect.get(globalThis, "playground");
      await fs.remove("/home/user/.config/bash-web/prompt.json");
    });
    await submit(page, "cd /home/user");
  }
}

async function exerciseConfig(page: Page, warnings: string[]) {
  await submit(page, "cd /home/user/prompt-draft");
  await writePromptConfig(page, '{"segments":{"git_branch":{"prefix":"ON "}}}');
  assert.match(await promptText(page, /ON /), /ON /);
  await writePromptConfig(page, '{"segments":{"git_branch":{"style":{"fg":true}}}}');
  assert.match(activePrompt(await page.evaluate(snapshotPrompt))[0] ?? "", /ON /, "Invalid style keeps last good config");
  await submit(page, "true");
  assert.equal(warnings.length, 1, "One pathful warning for one invalid config");
  assert.match(warnings[0] ?? "", /segments\.git_branch\.style\.fg/);
  await writePromptConfig(page, '{"unknown":true}');
  assert.match(activePrompt(await page.evaluate(snapshotPrompt))[0] ?? "", /ON /, "Unknown keys keep last good config");
  await submit(page, "true");
  assert.equal(warnings.length, 2, "Unknown-key warning is not repeated on the next prompt");
  return { warnings: warnings.slice() };
}

async function checkVersions(page: Page) {
  await submit(page, "mkdir -p /home/user/prompt-versions && cd /home/user/prompt-versions && printf '{}' > bun.lock && bun --version > /tmp/prompt-bun-version && node --version > /tmp/prompt-node-version");
  const bun = await promptText(page, /🥟/);
  assert.match(bun, /🥟/);
  assert.doesNotMatch(bun, /🥟\s*v\d/, "Host declares no unproven Bun version");
  await submit(page, `rm bun.lock && printf '{"name":"prompt-versions"}' > package.json`);
  const node = await promptText(page, //);
  assert.match(node, //);
  assert.doesNotMatch(node, /\s*v\d/, "Host declares no unproven Node version");
  const versions = await page.evaluate(async () => {
    const { fs }: ObservedPlayground = Reflect.get(globalThis, "playground");
    const decoder = new TextDecoder();
    return { bun: decoder.decode(await fs.readFile("/tmp/prompt-bun-version")).trim(), node: decoder.decode(await fs.readFile("/tmp/prompt-node-version")).trim() };
  });
  assert.match(versions.bun, /^\d+\.\d+\.\d+/);
  assert.match(versions.node, /^\d+\.\d+\.\d+/);
  return { declared: {}, printed: versions, bun, node };
}

async function promptText(page: Page, pattern: RegExp): Promise<string> {
  await page.waitForFunction(`async () => {
    const snapshot = await (${snapshotPrompt.toString()})();
    const lines = (${activePrompt.toString()})(snapshot);
    return ${pattern.toString()}.test(lines[0] ?? "");
  }`);
  return activePrompt(await page.evaluate(snapshotPrompt))[0] ?? "";
}

async function checkGitMarkers(page: Page, fixtures: readonly PromptRepositoryFixture[]) {
  const providerStateFixtures: { step: string; prompt: string }[] = [];
  for (const fixture of fixtures) {
    const root = await prepareRepository(page, `git-${fixture.step.replaceAll(" ", "-")}`, fixture);
    await submit(page, `cd ${root}`);
    providerStateFixtures.push({ step: fixture.step, prompt: await promptText(page, fixture.pattern) });
  }
  await submit(page, "cd /home/user");
  return {
    evidenceKind: "provider-state-only",
    fixtureSource: "Temporary host Git SHA-1/index-v2 snapshots; merge and corrupt-index metadata written directly",
    commandBacked: [],
    providerStateFixtures,
    unsupportedFormat: "SHA-256/reftable command coverage requires actual qualified Git capability evidence",
  };
}
