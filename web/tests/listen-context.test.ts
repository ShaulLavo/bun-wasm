import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

type Observation = [site: string, store: unknown];
type Result = { results: Record<string, Observation[]>; caller?: Observation[] };

function run(mode: string, protocol = "http"): Result {
  const fixture = new URL("./fixtures/listen-context.ts", import.meta.url).pathname;
  const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fixture, mode, protocol], { encoding: "utf8", timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const line = result.stdout.split("\n").find(value => value.startsWith("LISTEN_CONTEXT_RESULT "));
  expect(line, result.stdout).toBeDefined();
  return JSON.parse(line!.slice("LISTEN_CONTEXT_RESULT ".length));
}

const reference = run("reference").results;

test("node:http callbacks keep the listen-time frame on the hook path, as under Node", () => {
  const hooks = run("hooks");
  expect(hooks.results).toEqual(reference);
  expect(hooks.caller).toEqual([["listening", "listen-frame"], ["caller", "caller"]]);
});

test("node:http callbacks keep the listen-time frame with a native continuation provider", () => {
  expect(run("native").results).toEqual(reference);
});

// A raw node:net server's listening, connection and bind error callbacks, and an outbound
// socket's connect and data callbacks, keep their registration frame across the host's root
// entry, with `enterWith`, a scoped `run` and unrelated ambient work after it.
const tcpReference = run("reference", "tcp").results;
const dialReference = run("reference", "dial").results;

test("node:net server callbacks keep the listen-time frame on the hook path, as under Node", () => {
  const hooks = run("hooks", "tcp");
  expect(hooks.results).toEqual(tcpReference);
  expect(hooks.caller).toEqual([["listening", "listen-frame"], ["caller", "caller"]]);
});

test("node:net server callbacks keep the listen-time frame with a native continuation provider", () => {
  expect(run("native", "tcp").results).toEqual(tcpReference);
});

test("outbound node:net sockets keep the connect-time frame on the hook path, as under Node", () => {
  const hooks = run("hooks", "dial");
  expect(hooks.results).toEqual(dialReference);
  expect(hooks.caller).toEqual([["connect", "dial-frame"], ["caller", "caller"]]);
});

test("outbound node:net sockets keep the connect-time frame with a native continuation provider", () => {
  expect(run("native", "dial").results).toEqual(dialReference);
});

test("outbound node:net sockets on a socket path keep the connect-time frame, as TCP dialing does", () => {
  const hooks = run("hooks", "unix");
  expect(hooks.results).toEqual(dialReference);
  expect(hooks.caller).toEqual([["connect", "dial-frame"], ["caller", "caller"]]);
  expect(run("native", "unix").results).toEqual(dialReference);
});
