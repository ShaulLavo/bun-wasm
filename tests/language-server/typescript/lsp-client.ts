// Drives a TypeScript language server over stdio the way an editor does and prints one
// `LSP_RESULT <json>` line. Run it from the fixture project directory:
//   bun <this file> <server entry> [server args...]
// It exits non-zero when an answer is not the TypeScript result the fixture expects.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Message = { id?: number; method?: string; params?: Json; result?: Json; error?: { code: number; message: string } };
type Diagnostic = { message: string; code?: number | string; severity?: number };
type Location = { uri: string; range: { start: { line: number; character: number } } };

const WARM_ROUNDS = 7;
const HANG_MS = 300_000;
const TRACE = Boolean(process.env.LSP_TRACE);

class Connection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly waiters: Array<() => void> = [];
  typescript: { version: string; source: string } | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  async waitForDiagnostics(uri: string, accept: (items: Diagnostic[]) => boolean): Promise<Diagnostic[]> {
    for (;;) {
      const items = this.diagnostics.get(uri);
      if (items && accept(items)) return items;
      await new Promise<void>(wake => this.waiters.push(wake));
    }
  }

  private send(message: Message): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    if (TRACE) console.error(`-> ${body.toString("utf8").slice(0, 200)}`);
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let message = this.take(); message; message = this.take()) this.dispatch(message);
  }

  private take(): Message | undefined {
    const end = this.buffer.indexOf("\r\n\r\n");
    if (end < 0) return undefined;
    const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, end).toString("ascii"))?.[1]);
    if (!Number.isFinite(length)) throw new Error(`frame without Content-Length: ${this.buffer.subarray(0, end)}`);
    const start = end + 4;
    if (this.buffer.byteLength < start + length) return undefined;
    const message = JSON.parse(this.buffer.subarray(start, start + length).toString("utf8")) as Message;
    this.buffer = this.buffer.subarray(start + length);
    return message;
  }

  private dispatch(message: Message): void {
    if (TRACE) console.error(`<- ${JSON.stringify(message).slice(0, 400)}`);
    if (message.id !== undefined && message.method) return this.answerServerRequest(message);
    if (message.id !== undefined) return this.settle(message);
    if (message.method === "$/typescriptVersion") this.typescript = message.params as { version: string; source: string };
    if (message.method !== "textDocument/publishDiagnostics") return;
    const params = message.params as { uri: string; diagnostics: Diagnostic[] };
    this.diagnostics.set(params.uri, params.diagnostics);
    for (const wake of this.waiters.splice(0)) wake();
  }

  private settle(message: Message): void {
    const waiter = this.pending.get(message.id!);
    this.pending.delete(message.id!);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(`${message.error.code} ${message.error.message}`));
    else waiter.resolve(message.result ?? null);
  }

  private answerServerRequest(message: Message): void {
    this.send({ id: message.id, result: null });
  }
}

function position(text: string, marker: string, offset = 0): { line: number; character: number } {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`marker ${JSON.stringify(marker)} not in fixture`);
  const before = text.slice(0, index + offset).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function hoverText(result: Json): string {
  const contents = (result as { contents?: Json } | null)?.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(part => (typeof part === "string" ? part : String((part as { value?: string }).value))).join("\n");
  return String((contents as { value?: string } | undefined)?.value ?? "");
}

function completionLabels(result: Json): string[] {
  const items = Array.isArray(result) ? result : ((result as { items?: Json[] } | null)?.items ?? []);
  return items.map(item => String((item as { label: string }).label));
}

function firstLocation(result: Json): Location {
  const value = Array.isArray(result) ? result[0] : result;
  const link = value as { targetUri?: string; targetSelectionRange?: Location["range"] } & Partial<Location>;
  if (link?.targetUri) return { uri: link.targetUri, range: link.targetSelectionRange! };
  check(link?.uri, `definition returned ${JSON.stringify(result)}`);
  return link as Location;
}

async function main(): Promise<void> {
  const [entry, ...serverArgs] = process.argv.slice(2);
  check(entry, "usage: lsp-client.ts <server entry> [server args...]");
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const project = resolve(".");
  const mainPath = join(project, "src/main.ts");
  const mainUri = pathToFileURL(mainPath).href;
  const text = readFileSync(mainPath, "utf8");
  const stderr: string[] = [];
  const child = spawn(process.execPath, [resolve(entry), ...serverArgs], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const exited = new Promise<never>((_, reject) => child.on("close", code => reject(new Error(`server exited ${code}: ${stderr.join("")}`))));
  const hang = setTimeout(() => {
    console.error(`LSP_HANG after ${elapsed()} ms; server stderr:\n${stderr.join("")}`);
    process.exit(3);
  }, HANG_MS);
  const lsp = new Connection(child);
  const call = (method: string, params: Json) => Promise.race([lsp.request(method, params), exited]);
  const at = (marker: string, offset = 0) => ({ textDocument: { uri: mainUri }, position: position(text, marker, offset) });

  const initialize = (await call("initialize", {
    // The editor is the page, not a guest process, so it has no PID to watch (Singapore sends null too).
    processId: null,
    rootUri: pathToFileURL(project).href,
    workspaceFolders: [{ uri: pathToFileURL(project).href, name: "fixture" }],
    capabilities: {
      textDocument: {
        hover: { contentFormat: ["markdown", "plaintext"] },
        completion: { completionItem: { snippetSupport: false } },
        definition: { linkSupport: false },
        publishDiagnostics: {},
        synchronization: { didSave: false },
      },
    },
    // One tsserver and no typings installer: each guest process reserves its own Wasm memory.
    initializationOptions: { disableAutomaticTypingAcquisition: true, tsserver: { useSyntaxServer: "never" } },
  })) as { capabilities?: Record<string, Json>; serverInfo?: { name?: string; version?: string } };
  const initializeMs = elapsed();
  check(initialize.capabilities?.hoverProvider, "server advertises hover");
  lsp.notify("initialized", {});
  lsp.notify("textDocument/didOpen", { textDocument: { uri: mainUri, languageId: "typescript", version: 1, text } });

  const broken = await Promise.race([lsp.waitForDiagnostics(mainUri, items => items.length > 0), exited]);
  const firstDiagnosticsMs = elapsed();
  check(broken.some(item => String(item.code) === "2322" && item.message.includes("Type 'string' is not assignable to type 'number'")), `type error diagnostic, got ${JSON.stringify(broken)}`);

  const hover = hoverText(await call("textDocument/hover", at("describePoint(origin)")));
  check(hover.includes("describePoint(point: Point): string"), `hover shows the checked signature, got ${hover}`);
  const completion = completionLabels(await call("textDocument/completion", at("origin.y", "origin.".length)));
  check(completion.includes("x") && completion.includes("y"), `completion lists Point members, got ${completion.slice(0, 20)}`);
  const local = firstLocation(await call("textDocument/definition", at("describePoint(origin)")));
  check(local.uri.endsWith("/src/geometry.ts") && local.range.start.line === 5, `definition jumps to geometry.ts:6, got ${JSON.stringify(local)}`);
  const external = firstLocation(await call("textDocument/definition", at("invariant(origin")));
  check(/\/node_modules\/tiny-invariant\/.*\.d\.ts$/.test(external.uri), `definition jumps into the package's .d.ts, got ${external.uri}`);

  const warm = { hover: [] as number[], completion: [] as number[], definition: [] as number[] };
  for (let round = 0; round < WARM_ROUNDS; round++) {
    for (const [name, method, params] of [
      ["hover", "textDocument/hover", at("describePoint(origin)")],
      ["completion", "textDocument/completion", at("origin.y", "origin.".length)],
      ["definition", "textDocument/definition", at("invariant(origin")],
    ] as const) {
      const before = performance.now();
      await call(method, params);
      warm[name].push(performance.now() - before);
    }
  }

  const fixedText = text.replace("const label: number", "const label: string");
  const changedAt = performance.now();
  lsp.notify("textDocument/didChange", { textDocument: { uri: mainUri, version: 2 }, contentChanges: [{ text: fixedText }] });
  await Promise.race([lsp.waitForDiagnostics(mainUri, items => items.length === 0), exited]);
  const fixDiagnosticsMs = Math.round(performance.now() - changedAt);

  await call("shutdown", null);
  lsp.notify("exit", null);
  clearTimeout(hang);
  console.log(`LSP_RESULT ${JSON.stringify({
    server: initialize.serverInfo ?? null,
    typescript: lsp.typescript,
    initializeMs,
    firstDiagnosticsMs,
    fixDiagnosticsMs,
    warmMedianMs: { hover: Math.round(median(warm.hover)), completion: Math.round(median(warm.completion)), definition: Math.round(median(warm.definition)) },
    answers: { diagnostic: broken[0]!.message, hover, completion: completion.filter(label => label === "x" || label === "y"), definition: local.uri, packageDefinition: external.uri },
  })}`);
  process.exit(0);
}

main().catch(error => {
  console.error(`LSP_FAILED ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
