import { expect, test } from "bun:test";
import { assertIdentityTree, decodeIdentity, decodeThread, type IdentityTree } from "../.internal/reproducers/process-identity-199-oracle.ts";

function snapshot(): IdentityTree {
  return { root: { pid: 1, ppid: 0 },
    siblings: [{ handle: 2, identity: { pid: 2, ppid: 1 } }, { handle: 3, identity: { pid: 3, ppid: 1 } }],
    thread: { identity: { pid: 1, ppid: 0 }, child: { handle: 5, identity: { pid: 5, ppid: 1 } }, nested: { pid: 1, ppid: 0 } } };
}

test("oracle accepts shared thread identity and ordinary child-from-thread identity", () => {
  expect(() => assertIdentityTree(snapshot(), true)).not.toThrow();
});

test("oracle rejects execution IDs presented as thread process IDs", () => {
  const tree = snapshot();
  tree.thread.identity.pid = 4;
  expect(() => assertIdentityTree(tree)).toThrow("worker threads must retain");
});

test("oracle rejects a nested thread with a caller process as its parent", () => {
  const tree = snapshot();
  tree.thread.nested.ppid = 1;
  expect(() => assertIdentityTree(tree)).toThrow("nested workers must retain");
});

test("oracle rejects child-from-thread ancestry that names the execution member", () => {
  const tree = snapshot();
  tree.thread.child.identity.ppid = 4;
  expect(() => assertIdentityTree(tree)).toThrow("including inside a thread");
});

test("oracle rejects a child identity that differs from its subprocess handle", () => {
  const tree = snapshot();
  tree.siblings[0]!.identity.pid = 7;
  expect(() => assertIdentityTree(tree)).toThrow("child process.pid must equal its handle");
});

test("oracle rejects duplicated ordinary process handles", () => {
  const tree = snapshot();
  tree.thread.child.handle = 3;
  expect(() => assertIdentityTree(tree)).toThrow("distinct handles");
});

test("fresh virtual root assertion is separate from native Bun controls", () => {
  const tree = snapshot();
  tree.root.ppid = 37;
  tree.thread.identity.ppid = 37;
  tree.thread.nested.ppid = 37;
  expect(() => assertIdentityTree(tree)).not.toThrow();
  expect(() => assertIdentityTree(tree, true)).toThrow("fresh runtime");
});

for (const value of [null, {}, { pid: "1", ppid: 0 }, { pid: 0, ppid: 0 }, { pid: 1, ppid: -1 }, { pid: 1, ppid: 1 }, { pid: 0x80000000, ppid: 0 }]) {
  test(`identity decoder rejects malformed boundary value ${JSON.stringify(value)}`, () => {
    expect(() => decodeIdentity(value)).toThrow();
  });
}

test("thread decoder validates its nested child and thread observations", () => {
  expect(decodeThread(snapshot().thread)).toEqual(snapshot().thread);
  expect(() => decodeThread({ identity: { pid: 1, ppid: 0 }, child: {}, nested: null })).toThrow();
});
