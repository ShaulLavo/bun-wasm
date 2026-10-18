import { expect, test } from "bun:test";
import { SubprocessHost, childTransport, type ChildTransport } from "../src/subprocess";

const ordinary = JSON.stringify({ argv: ["bun", "-e", "0"] });
const configuration = JSON.stringify({ purpose: "configuration", argv: ["bun", "--no-install", "-e", "0"], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
function fixture(parent?: ChildTransport) {
  const launched: ChildTransport[] = [];
  const host = new SubprocessHost({
    budget: parent?.budget, slot: parent?.slot, token: parent?.token,
    identity: parent?.identity, pid: parent?.pid, jobId: parent?.jobId,
    output() {}, launch(_meta, transport) { launched.push(transport); return { terminate() {} }; },
  });
  return { host, launched };
}

test("four public children each retain one internal evaluation and the root has one", () => {
  const root = fixture();
  const owners: ReturnType<typeof fixture>[] = [];
  try {
    for (let i = 0; i < 4; i++) expect(root.host.spawn(ordinary)).toBeGreaterThan(0);
    expect(root.host.spawn(ordinary)).toBe(-1);
    for (const transport of root.launched) owners.push(fixture(transport));
    owners.push(root);
    for (const owner of owners) {
      expect(owner.host.spawn(configuration)).toBeGreaterThan(0);
      expect(owner.host.spawn(configuration)).toBe(-1);
      expect(owner.host.lastError).toContain("EAGAIN");
      const helper = fixture(owner.launched.at(-1));
      try {
        expect(helper.host.spawn(configuration)).toBe(-1);
        expect(helper.host.lastError).toContain("EPERM");
        expect(helper.host.spawn(ordinary)).toBe(-1);
      } finally { helper.host.dispose(); }
    }
  } finally {
    for (const owner of owners) owner.host.dispose();
    root.host.dispose();
  }
  expect(Array.from(new Int32Array(root.host.budget).subarray(2)).every(value => value === 0)).toBe(true);
});

test("internal termination and close release the slot, child and pipe handles", () => {
  const { host, launched } = fixture();
  try {
    for (let i = 0; i < 8; i++) {
      const pid = host.spawn(configuration);
      expect(pid).toBeGreaterThan(0);
      expect(host.kill(pid, 9)).toBe(0);
      expect(host.wait(pid)).toBe(137);
      expect(host.close(pid)).toBe(0);
      expect(host.children.size).toBe(0);
      expect(host.handles.size).toBe(0);
      expect(Array.from(new Int32Array(host.budget).subarray(2)).every(value => value === 0)).toBe(true);
    }
    const pid = host.spawn(configuration);
    childTransport(launched.at(-1)!).finish(0);
    expect(host.wait(pid)).toBe(0);
    host.close(pid);
  } finally { host.dispose(); }
});

test("failed helper launch and invalid metadata cannot consume reserved capacity", () => {
  const host = new SubprocessHost({ output() {}, launch() { throw new Error("fixture failure"); } });
  try {
    for (let i = 0; i < 8; i++) {
      expect(host.spawn(configuration)).toBe(-1);
      expect(JSON.parse(host.lastError!)).toMatchObject({ code: "EACCES", errno: -13, path: "bun", syscall: "posix_spawn" });
      expect(host.children.size).toBe(0);
      expect(host.handles.size).toBe(0);
    }
    expect(host.spawn(JSON.stringify({ purpose: "configuration", argv: ["bun", "run", "anything"] }))).toBe(-1);
    expect(host.lastError).toContain("EINVAL");
    expect(Array.from(new Int32Array(host.budget).subarray(2)).every(value => value === 0)).toBe(true);
  } finally { host.dispose(); }
});
