import assert from "node:assert/strict";

export interface Identity { pid: number; ppid: number }
export interface ChildIdentity { handle: number; identity: Identity }
export interface ThreadIdentity { identity: Identity; child: ChildIdentity; nested: Identity }
export interface IdentityTree { root: Identity; siblings: ChildIdentity[]; thread: ThreadIdentity }
type ExitObservation = { kind: "creator"; identity: Identity; child: number } | { kind: "survivor"; before: Identity; after: Identity };

export function decodeExitObservation(value: unknown): ExitObservation {
  if (!value || typeof value !== "object" || !("kind" in value)) throw new Error("Missing exit observation");
  if (value.kind === "creator" && "identity" in value && "child" in value && typeof value.child === "number") {
    return { kind: "creator", identity: decodeIdentity(value.identity), child: value.child };
  }
  if (value.kind === "survivor" && "before" in value && "after" in value) {
    return { kind: "survivor", before: decodeIdentity(value.before), after: decodeIdentity(value.after) };
  }
  throw new Error("Invalid exit observation");
}

export function assertParentExit(creator: Identity, handle: number, before: Identity, after: Identity): void {
  assert.equal(before.pid, handle, "survivor must report its subprocess handle");
  assert.equal(before.ppid, creator.pid, "survivor must name its creation parent");
  assert.deepEqual(after, before, "parent collection must preserve immutable process ancestry");
}

export function decodeIdentity(value: unknown): Identity {
  if (!value || typeof value !== "object" || !("pid" in value) || !("ppid" in value)) throw new Error("Missing identity");
  if (typeof value.pid !== "number" || typeof value.ppid !== "number") throw new Error("Invalid identity");
  const identity = { pid: value.pid, ppid: value.ppid };
  assertIdentity(identity);
  return identity;
}

function decodeChild(value: unknown): ChildIdentity {
  if (!value || typeof value !== "object" || !("handle" in value) || !("identity" in value)) throw new Error("Missing child identity");
  if (typeof value.handle !== "number") throw new Error("Invalid child handle");
  return { handle: value.handle, identity: decodeIdentity(value.identity) };
}

export function decodeThread(value: unknown): ThreadIdentity {
  if (!value || typeof value !== "object" || !("identity" in value) || !("child" in value) || !("nested" in value)) throw new Error("Missing thread identity");
  return { identity: decodeIdentity(value.identity), child: decodeChild(value.child), nested: decodeIdentity(value.nested) };
}

export function decodeTree(value: unknown): IdentityTree {
  if (!value || typeof value !== "object" || !("root" in value) || !("siblings" in value) || !("thread" in value)) throw new Error("Missing process tree");
  if (!Array.isArray(value.siblings)) throw new Error("Invalid sibling observations");
  return { root: decodeIdentity(value.root), siblings: value.siblings.map(decodeChild), thread: decodeThread(value.thread) };
}

export function assertNonrootTree(handle: number, creator: Identity, tree: IdentityTree): void {
  assert.equal(tree.root.pid, handle, "nonroot leader must report its own subprocess handle");
  assert.equal(tree.root.ppid, creator.pid, "nonroot leader must name its creating process");
  assert.notEqual(tree.root.pid, creator.pid, "nonroot leader cannot reuse the root identity");
  assertIdentityTree(tree);
}

function assertIdentity(identity: Identity): void {
  assert.ok(Number.isInteger(identity.pid) && identity.pid > 0 && identity.pid <= 0x7fffffff, "pid must be a positive signed i32");
  assert.ok(Number.isInteger(identity.ppid) && identity.ppid >= 0 && identity.ppid <= 0x7fffffff, "ppid must be a nonnegative signed i32");
  assert.notEqual(identity.ppid, identity.pid, "process cannot be its own creation parent");
}

export function assertIdentityTree(tree: IdentityTree, virtualRoot = false): void {
  assertIdentity(tree.root);
  if (virtualRoot) assert.deepEqual(tree.root, { pid: 1, ppid: 0 }, "a fresh runtime must admit root 1/0");
  assert.equal(tree.siblings.length, 2);
  const children = tree.siblings.concat([tree.thread.child]);
  assert.equal(new Set(children.map(child => child.handle)).size, children.length, "ordinary children must have distinct handles");
  for (const child of children) {
    assertIdentity(child.identity);
    assert.equal(child.identity.pid, child.handle, "child process.pid must equal its handle");
    assert.equal(child.identity.ppid, tree.root.pid, "child process.ppid must name the creating process, including inside a thread");
    assert.notEqual(child.identity.pid, tree.root.pid, "ordinary child needs a distinct process identity");
  }
  assert.deepEqual(tree.thread.identity, tree.root, "worker threads must retain their process identity");
  assert.deepEqual(tree.thread.nested, tree.root, "nested workers must retain the whole process identity");
}
