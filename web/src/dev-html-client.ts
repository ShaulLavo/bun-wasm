export type Stamp = { readonly server: string; readonly revision: number };
type Policy = (string | null)[];
export type Config = { stamp: Stamp; paths: { client: string; events: string }; html: string; policy: Policy };
type Baseline = { tree: Document; live: Map<Node, Node>; stamp: Stamp; policy: Policy };
type Candidate = { tree: Document; stamp: Stamp; policy: Policy };
type Job = { controller: AbortController; revision: number; candidate?: Candidate; staleRetry: boolean };
type Active = { baseline: Baseline; desired: number; socket: WebSocket; job: Job | null; attempted: number };
type State =
  | { kind: "waiting"; active: Active }
  | { kind: "running"; active: Active }
  | { kind: "suspended"; baseline: Baseline }
  | { kind: "closed" };
type Change = { kind: "text"; node: Node; before: string | null; after: string | null }
  | { kind: "attribute"; node: Element; name: string; namespace: string | null; before: string | null; after: string | null };
const limit = 256 * 1024;
const maxNodes = 32_768;
const marker = "data-bun-wasm-dev";
const socketMarker = "data-bun-wasm-socket";
const rawHeader = "x-bun-wasm-dev-raw";
const stampHeader = "x-bun-wasm-dev-stamp";
const policyHeader = "x-bun-wasm-dev-policy";

export function parseStamp(value: unknown): Stamp {
  if (!value || typeof value !== "object" || !("server" in value) || !("revision" in value)) throw new Error("invalid revision");
  if (typeof value.server !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.server)) throw new Error("invalid server");
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("invalid revision");
  return { server: value.server, revision: value.revision };
}

export function parseNotice(data: unknown): Stamp {
  if (typeof data !== "string" || data.length > 1024) throw new Error("invalid revision frame");
  const notice: unknown = JSON.parse(data);
  if (!notice || typeof notice !== "object" || !("kind" in notice) || notice.kind !== "committed" || !("stamp" in notice)) throw new Error("invalid revision frame");
  return parseStamp(notice.stamp);
}

function parsePolicy(value: unknown): Policy {
  if (!Array.isArray(value) || value.length !== 6 || !value.every(entry => entry === null || typeof entry === "string")) throw new Error("invalid policy metadata");
  return value;
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || !("stamp" in value) || !("paths" in value) || !("html" in value) || !("policy" in value)) throw new Error("invalid config");
  const stamp = parseStamp(value.stamp);
  const paths = value.paths;
  const prefix = `/_bun/wasm-dev/${encodeURIComponent(stamp.server)}`;
  if (!paths || typeof paths !== "object" || !("client" in paths) || paths.client !== `${prefix}/client.js` || !("events" in paths) || paths.events !== `${prefix}/events`) throw new Error("invalid endpoint");
  if (typeof value.html !== "string" || new TextEncoder().encode(value.html).length > limit) throw new Error("invalid baseline size");
  return { stamp, paths: { client: paths.client, events: paths.events }, html: value.html, policy: parsePolicy(value.policy) };
}

function ignored(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.tagName === "SCRIPT" && (node.getAttribute(marker) === "config" || node.getAttribute(marker) === "client" || node.getAttribute(socketMarker) === "shim");
}

function children(node: Node): Node[] { return Array.from(node.childNodes).filter(child => !ignored(child)); }

function nodes(root: Node): Node[] {
  const result: Node[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    result.push(node);
    if (result.length > maxNodes) throw new Error("unsupported node count");
    const items = children(node);
    items.reverse();
    pending.push(...items);
  }
  return result;
}

function identity(left: Node, right: Node): boolean {
  if (left.nodeType !== right.nodeType) return false;
  if (left instanceof Element && right instanceof Element) return left.localName === right.localName && left.namespaceURI === right.namespaceURI && left.id === right.id;
  return left.nodeName === right.nodeName;
}

function validateTree(tree: Document): Document {
  const ids = new Set<string>();
  for (const node of nodes(tree)) {
    if (!(node instanceof Element)) continue;
    if (node.hasAttribute(marker) || node.hasAttribute(socketMarker)) throw new Error("unsupported reserved marker");
    if (node.id && ids.has(node.id)) throw new Error("unsupported duplicate ID");
    if (node.id) ids.add(node.id);
  }
  return tree;
}

function parse(html: string): Document {
  return validateTree(new DOMParser().parseFromString(html, "text/html"));
}

function authorTree(html: string): Document {
  const tree = new DOMParser().parseFromString(html, "text/html");
  for (const shim of tree.querySelectorAll(`script[${socketMarker}="shim"]`)) shim.remove();
  return validateTree(tree);
}

function bind(tree: Document, document: Document): Map<Node, Node> {
  const live = new Map<Node, Node>([[tree, document]]);
  const pending: [Node, Node][] = [[tree, document]];
  while (pending.length) {
    const pair = pending.pop();
    if (!pair) break;
    bindChildren(pair[0], pair[1], live, pending);
  }
  return live;
}

function bindChildren(author: Node, target: Node, live: Map<Node, Node>, pending: [Node, Node][]): void {
  const actual = children(target);
  let index = 0;
  for (const child of children(author)) {
    const byId = child instanceof Element && child.id ? target.ownerDocument?.getElementById(child.id) : null;
    const match = byId?.parentNode === target ? byId : actual.slice(index).find(node => identity(child, node));
    if (!match) continue;
    index = actual.indexOf(match) + 1;
    live.set(child, match);
    pending.push([child, match]);
  }
}

function attributes(element: Element): string {
  return JSON.stringify(Array.from(element.attributes, attr => [attr.namespaceURI, attr.name, attr.value]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
}

function protectedElement(element: Element): boolean {
  return element.localName.includes("-") || element.hasAttribute("is") || ["script", "iframe", "object", "embed", "base"].includes(element.localName)
    || element.localName === "meta";
}

function safeAttribute(name: string, value: string | null): boolean {
  if (name.toLowerCase().startsWith("on") || ["srcdoc", "is", "id", marker, socketMarker].includes(name.toLowerCase())) return false;
  if (value === null) return true;
  const normalized = Array.from(value).filter(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127).join("").toLowerCase();
  return !/^(?:javascript|vbscript|data):/.test(normalized);
}

function liveNode(baseline: Baseline, node: Node): Node {
  const target = baseline.live.get(node);
  if (!target?.isConnected || !identity(node, target) || node.parentNode && target.parentNode !== baseline.live.get(node.parentNode)) throw new Error("conflict: author node was replaced");
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.localName.includes("-") || parent.hasAttribute("is") || parent.shadowRoot) throw new Error("unsupported custom or shadow tree");
  }
  if (target instanceof Element && (target.shadowRoot || target.localName.includes("-") || target.hasAttribute("is"))) throw new Error("unsupported custom or shadow tree");
  return target;
}

function elementChanges(before: Element, after: Element, baseline: Baseline, changes: Change[]): void {
  if (attributes(before) === attributes(after)) return;
  if (protectedElement(before)) throw new Error(`unsupported ${before.localName} change`);
  const target = liveNode(baseline, before);
  if (!(target instanceof Element)) throw new Error("conflict: element changed kind");
  const names = new Map(Array.from(before.attributes, attr => [attr.name, attr]));
  for (const attr of after.attributes) if (!names.has(attr.name)) names.set(attr.name, attr);
  for (const [name, attr] of names) {
    const oldValue = before.getAttributeNS(attr.namespaceURI, attr.localName);
    const value = after.getAttributeNS(attr.namespaceURI, attr.localName);
    if (oldValue === value) continue;
    if (!safeAttribute(name, value)) throw new Error("unsupported active attribute");
    if (target.getAttributeNS(attr.namespaceURI, attr.localName) !== oldValue) throw new Error("conflict: application changed an author attribute");
    changes.push({ kind: "attribute", node: target, name, namespace: attr.namespaceURI, before: oldValue, after: value });
  }
}

function preflight(baseline: Baseline, candidate: Candidate): { changes: Change[]; live: Map<Node, Node> } {
  if (JSON.stringify(candidate.policy) !== JSON.stringify(baseline.policy)) throw new Error("unsupported response policy change");
  const previous = nodes(baseline.tree);
  const next = nodes(candidate.tree);
  if (previous.length !== next.length) throw new Error("unsupported topology change");
  const live = new Map<Node, Node>();
  const changes: Change[] = [];
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index];
    const after = next[index];
    if (!before || !after || !identity(before, after) || children(before).length !== children(after).length) throw new Error("unsupported topology change");
    compareNode(before, after, baseline, changes);
    const target = baseline.live.get(before);
    if (target) live.set(after, target);
  }
  return { changes, live };
}

function compareNode(before: Node, after: Node, baseline: Baseline, changes: Change[]): void {
  if (before instanceof DocumentType && after instanceof DocumentType) {
    if (before.name !== after.name || before.publicId !== after.publicId || before.systemId !== after.systemId) throw new Error("unsupported doctype change");
    return;
  }
  if (before instanceof Element && after instanceof Element) elementChanges(before, after, baseline, changes);
  if (before.nodeValue === after.nodeValue) return;
  if (before.parentElement && protectedElement(before.parentElement)) throw new Error(`unsupported ${before.parentElement.localName} content`);
  const target = liveNode(baseline, before);
  if (target.nodeValue !== before.nodeValue) throw new Error("conflict: application changed author text");
  changes.push({ kind: "text", node: target, before: before.nodeValue, after: after.nodeValue });
}

function write(change: Change, value: string | null): void {
  if (change.kind === "text") { change.node.nodeValue = value; return; }
  if (value === null) { change.node.removeAttributeNS(change.namespace, change.name.includes(":") ? change.name.split(":").at(-1)! : change.name); return; }
  change.node.setAttributeNS(change.namespace, change.name, value);
}

function apply(baseline: Baseline, candidate: Candidate): Baseline {
  const patch = preflight(baseline, candidate);
  const applied: Change[] = [];
  try {
    for (const change of patch.changes) { applied.push(change); write(change, change.after); }
  } catch (error) {
    for (const change of applied.reverse()) write(change, change.before);
    throw error;
  }
  return { tree: candidate.tree, live: patch.live, stamp: candidate.stamp, policy: candidate.policy };
}

export async function readHtml(response: Response, signal: AbortSignal): Promise<string> {
  if (response.status !== 200 || !/^text\/html\s*(?:;\s*charset\s*=\s*["']?utf-8["']?\s*)?$/i.test(response.headers.get("content-type") ?? "")) throw new Error("unsupported HTML response");
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let html = "";
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("update aborted");
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("update aborted");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("HTML exceeds 256 KiB");
      html += decoder.decode(chunk.value, { stream: true });
    }
    return html + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function startDevelopmentHtml(document: Document, window: Window & typeof globalThis): (() => void) | undefined {
  const configNode = document.querySelector(`script[${marker}="config"]`);
  if (!configNode || document.documentElement.hasAttribute(marker)) return;
  document.documentElement.setAttribute(marker, "active");
  function report(message: string): void { window.console.error(`[bun-wasm development HTML] ${message}`); }
  let config: Config;
  try { config = parseConfig(JSON.parse(configNode.textContent ?? "")); }
  catch (error) { configNode.remove(); report(String(error)); return; }
  configNode.remove();
  const tree = parse(config.html);
  const baseline: Baseline = { tree, live: bind(tree, document), stamp: config.stamp, policy: config.policy };
  const endpoint = config.paths.events;
  config.html = "";
  let state: State = { kind: "suspended", baseline };

  function active(): Active | null { return state.kind === "running" || state.kind === "waiting" ? state.active : null; }

  function detach(current: Active): void {
    current.job?.controller.abort();
    current.job = null;
    current.socket.onmessage = null;
    current.socket.onclose = null;
    current.socket.onerror = null;
    current.socket.close();
  }

  function close(message?: string): void {
    const previous = active();
    state = { kind: "closed" };
    if (previous) detach(previous);
    window.removeEventListener("pagehide", hide, true);
    window.removeEventListener("pageshow", show);
    document.removeEventListener("DOMContentLoaded", ready);
    if (message) report(message);
  }

  function connect(baseline: Baseline): void {
    const url = new URL(endpoint, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new window.WebSocket(url);
    const current: Active = { baseline, desired: baseline.stamp.revision, socket, job: null, attempted: baseline.stamp.revision };
    state = document.readyState !== "complete" ? { kind: "waiting", active: current } : { kind: "running", active: current };
    socket.onmessage = event => notice(current, event.data);
    // Window-target listeners can run in registration order, even with capture.
    // Let pagehide suspend before the shim's synchronous error becomes terminal.
    const disconnected = () => window.queueMicrotask(() => { if (active() === current) close("disconnected"); });
    socket.onclose = disconnected;
    socket.onerror = disconnected;
  }

  function notice(current: Active, data: unknown): void {
    if (active() !== current) return;
    let stamp: Stamp;
    try { stamp = parseNotice(data); }
    catch (error) { close(String(error)); return; }
    if (stamp.server !== current.baseline.stamp.server) { close("server instance changed"); return; }
    if (stamp.revision <= current.desired) return;
    current.desired = stamp.revision;
    if (current.job?.candidate && current.job.candidate.stamp.revision <= current.desired) { finish(current, current.job); return; }
    current.job?.controller.abort();
    current.job = null;
    schedule(current);
  }

  function ready(): void {
    if (state.kind !== "waiting") return;
    const current = state.active;
    state = { kind: "running", active: current };
    schedule(current);
  }

  function schedule(current: Active, staleRetry = false): void {
    if (state.kind !== "running" || active() !== current || current.job || current.desired <= current.baseline.stamp.revision) return;
    if (!staleRetry && current.attempted >= current.desired) return;
    current.attempted = current.desired;
    const job: Job = { revision: current.desired, controller: new AbortController(), staleRetry };
    current.job = job;
    void fetchCandidate(current, job);
  }

  async function fetchCandidate(current: Active, job: Job): Promise<void> {
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      const response = await window.fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { [rawHeader]: "1" }, signal: job.controller.signal });
      const html = await readHtml(response, job.controller.signal);
      if (active() !== current || current.job !== job || job.controller.signal.aborted) return;
      const stamp = parseStamp(JSON.parse(response.headers.get(stampHeader) ?? "null"));
      if (stamp.server !== current.baseline.stamp.server) throw new Error("server instance changed");
      job.candidate = { tree: authorTree(html), stamp, policy: parsePolicy(JSON.parse(response.headers.get(policyHeader) ?? "null")) };
      finish(current, job);
    } catch (error) {
      if (active() !== current || current.job !== job || job.controller.signal.aborted) return;
      job.controller.abort();
      current.job = null;
      report(String(error));
    }
  }

  function finish(current: Active, job: Job): void {
    if (state.kind !== "running" || active() !== current || current.job !== job || job.controller.signal.aborted || !job.candidate) return;
    const candidate = job.candidate;
    if (candidate.stamp.revision > current.desired) return;
    current.job = null;
    if (candidate.stamp.revision < current.desired) { if (!job.staleRetry) schedule(current, true); return; }
    try { current.baseline = apply(current.baseline, candidate); }
    catch (error) { close(String(error)); }
  }

  function hide(event: PageTransitionEvent): void {
    const previous = active();
    if (!previous) return;
    if (!event.persisted) { close(); return; }
    state = { kind: "suspended", baseline: previous.baseline };
    detach(previous);
  }

  function show(event: PageTransitionEvent): void {
    if (event.persisted && state.kind === "suspended") connect(state.baseline);
  }

  window.addEventListener("pagehide", hide, true);
  window.addEventListener("pageshow", show);
  document.addEventListener("DOMContentLoaded", ready, { once: true });
  try { connect(baseline); }
  catch (error) { close(String(error)); }
  return () => close();
}

if (typeof document !== "undefined" && typeof window !== "undefined") startDevelopmentHtml(document, window);
