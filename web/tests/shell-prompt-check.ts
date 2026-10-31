import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { Terminal } from "@xterm/xterm";
import type { BrowserSession } from "bash-web/session";
import type { Runtime } from "waffle";

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
    await restore();
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
export async function snapshotPrompt(): Promise<PromptSnapshot> {
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

export function activePrompt(snapshot: PromptSnapshot): string[] {
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
  const late = await pendingUpdate(page, "draft", "echo typed", false);
  const paste = await pendingUpdate(page, "paste", "printf first\nprintf second", false);
  const interrupted = await pendingUpdate(page, "interrupt", "echo cancelled", true);
  const narrow = await checkNarrowPrompt(page);
  const git = await checkGitMarkers(page);
  const config = await checkConfig(page);
  const versions = await checkVersions(page);
  await submit(page, "cd /home/user");
  console.log(`ok ${browser}/${engine}: default prompt and controlled same-turn redraw`);
  return { mode: "on", browser, engine, initial, late, paste, interrupted, narrow, git, config, versions };
}

async function prepareRepository(page: Page, name: string): Promise<string> {
  const root = `/home/user/prompt-${name}`;
  await submit(page, `mkdir -p ${root} && git -C ${root} init && printf base > ${root}/tracked.txt && printf '{}' > ${root}/bun.lock && git -C ${root} add tracked.txt bun.lock && git -C ${root} -c user.name=test -c user.email=test@example.test commit -m base`);
  // The provider has never entered this repository, so no clean-file status cache can mask this read.
  await page.evaluate(async path => {
    const { fs }: ObservedPlayground = Reflect.get(globalThis, "playground");
    await fs.writeFile(path, "modified tracked contents for the pending-read control");
  }, `${root}/tracked.txt`);
  return root;
}

async function installBarrier(page: Page, path: string): Promise<void> {
  await page.evaluate(`globalThis.promptReadBarrier = (${armPromptReadBarrier.toString()})(globalThis.playground.runtime.filesystem, ${JSON.stringify(path)});
globalThis.promptCapture = ${snapshotPrompt.toString()};
globalThis.promptLines = ${activePrompt.toString()};`);
}

async function waitForBlockedRead(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const barrier: PromptReadBarrier = Reflect.get(globalThis, "promptReadBarrier");
    return barrier.blocked;
  });
}

async function releaseBarrier(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const barrier: PromptReadBarrier = Reflect.get(globalThis, "promptReadBarrier");
    barrier.release();
    await barrier.finished;
  });
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

async function pendingUpdate(page: Page, name: string, draft: string, interrupt: boolean) {
  await page.evaluate(`async () => {
    globalThis.restorePromptReadBudget = await (${installPromptReadBudget.toString()})(globalThis.playground.fs);
  }`);
  try {
    const root = await prepareRepository(page, name);
    await installBarrier(page, `${root}/tracked.txt`);
    return await exercisePendingUpdate(page, root, draft, interrupt);
  } finally {
    await restorePendingFixture(page);
    await submit(page, "cd /home/user");
  }
}

async function restorePendingFixture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const barrier: PromptReadBarrier | undefined = Reflect.get(globalThis, "promptReadBarrier");
    const restoreBudget: () => Promise<void> = Reflect.get(globalThis, "restorePromptReadBudget");
    try {
      barrier?.restore();
      if (barrier?.blocked) await barrier.finished;
    } finally {
      await restoreBudget();
      Reflect.deleteProperty(globalThis, "promptReadBarrier");
      Reflect.deleteProperty(globalThis, "promptCapture");
      Reflect.deleteProperty(globalThis, "promptLines");
      Reflect.deleteProperty(globalThis, "restorePromptReadBudget");
    }
  });
}

async function exercisePendingUpdate(page: Page, root: string, draft: string, interrupt: boolean) {
  const submission = submit(page, `cd ${root}`);
  void submission.catch(() => {});
  // Observe the actual uncached status read before accepting any redraw evidence.
  await waitForBlockedRead(page);
  await submission;
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
  assert.doesNotMatch(activePrompt(before)[0] ?? "", /\[[^\]]*!/, "Actual status completion remains blocked while the draft is typed");
  if (interrupt) return interruptPendingUpdate(page, before);
  await releaseBarrier(page);
  await updatedStatus(page, before.generation);
  const after = await page.evaluate(snapshotPrompt);
  assertPreservedDraft(before, after);
  await submit(page, "cd /home/user");
  return { kind: "redraw", before, after };
}

async function interruptPendingUpdate(page: Page, before: PromptSnapshot) {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  await page.waitForFunction(previous => {
    const { shell }: ObservedPlayground = Reflect.get(globalThis, "playground");
    return String(shell.lastPrompt?.generation) !== previous && !shell.running;
  }, before.generation);
  // Leave the repository so the new turn cannot legitimately publish the old status marker.
  await submit(page, "cd /home/user");
  const fresh = await page.evaluate(snapshotPrompt);
  await releaseBarrier(page);
  const after = await page.evaluate(snapshotPrompt);
  assert.deepEqual(activePrompt(after), activePrompt(fresh), "Cancelled read never redraws the new prompt");
  assert.equal(after.generation, fresh.generation);
  return { kind: "interrupt", before, fresh, after };
}

async function checkNarrowPrompt(page: Page) {
  const geometry = await page.evaluate(() => {
    const { term }: ObservedPlayground = Reflect.get(globalThis, "playground");
    const dimensions = { cols: term.cols, rows: term.rows };
    term.resize(32, 24);
    return dimensions;
  });
  try {
    const result = await pendingUpdate(page, "narrow-repository-that-wraps-the-first-line", "echo narrow", false);
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

async function checkGitMarkers(page: Page) {
  const root = "/home/user/prompt-git";
  await submit(page, `mkdir -p ${root} && cd ${root} && git init -b main && printf base > tracked.txt && git add tracked.txt && git -c user.name=test -c user.email=test@example.test commit -m base && git config user.name test && git config user.email test@example.test`);
  const commandBacked: { step: string; prompt: string }[] = [];
  const cases: readonly (readonly [string, string, RegExp])[] = [
    ["branch", "true", /on .*main/],
    ["detached", "git checkout --detach", /\([0-9a-f]{7}\)/],
    ["modified", "git checkout main && printf modified > tracked.txt", /\[[^\]]*!/],
    ["deleted", "rm tracked.txt", /\[[^\]]*✘/],
    ["untracked", "git checkout -- tracked.txt && printf new > untracked.txt", /\[[^\]]*\?/],
    ["staged", "git add untracked.txt", /\[[^\]]*\+/],
    ["stash", "git stash push", /\[[^\]]*\$/],
    ["ahead", "git branch prompt-upstream && git config branch.main.remote . && git config branch.main.merge refs/heads/prompt-upstream && printf ahead > ahead.txt && git add ahead.txt && git commit -m ahead", /⇡/],
    ["behind", "git branch -f prompt-upstream HEAD && git reset --hard HEAD~1", /⇣/],
    ["diverged", "printf diverged > diverged.txt && git add diverged.txt && git commit -m diverged", /⇕/],
    ["missing upstream", "git config branch.main.merge refs/heads/prompt-missing", /…/],
  ];
  for (const [step, command, pattern] of cases) {
    await submit(page, command);
    commandBacked.push({ step, prompt: await promptText(page, pattern) });
  }
  await submit(page, "git config --unset branch.main.remote && git config --unset branch.main.merge && git rev-parse HEAD > /tmp/prompt-head");
  const providerStateFixtures = await checkProviderState(page, root);
  await submit(page, "cd /home/user");
  return { commandBacked, providerStateFixtures };
}

async function checkProviderState(page: Page, root: string) {
  // These direct metadata writes exercise provider states, not end-to-end Git commands.
  await page.evaluate(async path => {
    const { fs }: ObservedPlayground = Reflect.get(globalThis, "playground");
    await fs.writeFile(`${path}/.git/MERGE_HEAD`, await fs.readFile("/tmp/prompt-head") ?? "");
  }, root);
  await submit(page, "true");
  const merging = await promptText(page, /MERGING/);
  await page.evaluate(async path => {
    const { fs }: ObservedPlayground = Reflect.get(globalThis, "playground");
    await fs.remove(`${path}/.git/MERGE_HEAD`);
    await fs.remove(`${path}/.git/index`);
    await fs.writeFile(`${path}/.git/index`, "corrupt index provider-state fixture");
  }, root);
  await submit(page, "true");
  const unknown = await promptText(page, /…/);
  assert.match(unknown, /…/, "Unreadable repository state must not claim clean");
  return { evidenceKind: "provider-state-only", merging, corruptIndex: unknown, unsupportedFormat: "SHA-256/reftable command coverage requires actual qualified Git capability evidence" };
}
