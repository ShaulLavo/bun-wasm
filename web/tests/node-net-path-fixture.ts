import { networkFixture } from "./node-net-fixture";

// Contract fixture only: Waffle supplies stream bytes, and this fixture supplies the
// Unix naming/address API, including the abstract-name rules of Waffle's contract
// (a leading NUL; at most 108 UTF-8 bytes). It proves no filesystem behavior.
export function unixNetworkFixture() {
  const paths = new Map<string, { listener: number; port: unknown }>();
  const addresses = new Map<number, { local: string | null; peer: string | null }>();
  const calls: unknown[][] = [];
  let failure: { code: string; syscall: string } | undefined;
  let closeFailure: string | undefined;
  const overrides = {
    hostListenPath(path: string, flags: number) {
      calls.push(["listen", path, flags]);
      const code = validate(path) || (paths.has(path) ? "EADDRINUSE" : undefined);
      if (code) return fail(code, "listen");
      const listener = Number(fixture.invoke("hostListen", "127.0.0.1", 0));
      paths.set(path, { listener, port: fixture.invoke("hostLocalPort", listener) });
      addresses.set(listener, { local: path, peer: null });
      return listener;
    },
    hostConnectPath(path: string) {
      calls.push(["connect", path]);
      const code = validate(path);
      if (code) return fail(code, "connect");
      const binding = paths.get(path);
      if (!binding) return fail(path.startsWith("\0") ? "ECONNREFUSED" : "ENOENT", "connect");
      const client = Number(fixture.invoke("hostConnect", "127.0.0.1", binding.port));
      addresses.set(client, { local: null, peer: path });
      return client;
    },
    hostAccept(listener: number) {
      const handle = Number(fixture.invoke("hostAccept", listener));
      const address = addresses.get(listener);
      if (handle > 0 && address) addresses.set(handle, { local: address.local, peer: null });
      return handle;
    },
    hostLocalAddr(handle: number) {
      const address = addresses.get(handle);
      return address ? JSON.stringify({ family: "Unix", path: address.local }) : fixture.invoke("hostLocalAddr", handle);
    },
    hostPeerAddr(handle: number) {
      const address = addresses.get(handle);
      return address ? JSON.stringify({ family: "Unix", path: address.peer }) : fixture.invoke("hostPeerAddr", handle);
    },
    hostError(handle: number) {
      return handle === 0 && failure ? JSON.stringify({ name: "Error", message: failure.code, ...failure }) : fixture.invoke("hostError", handle);
    },
    hostClose(handle: number) {
      const listener = Array.from(paths.values()).some(binding => binding.listener === handle);
      for (const [path, binding] of paths) if (binding.listener === handle) paths.delete(path);
      addresses.delete(handle);
      const result = fixture.invoke("hostClose", handle);
      if (listener && closeFailure) return fail(closeFailure, "close");
      return result;
    },
  };
  function fail(code: string, syscall: string) { failure = { code, syscall }; return -1; }
  function validate(path: string) {
    if (path.startsWith("\0")) return path.length === 1 || new TextEncoder().encode(path).length > 108 ? "EINVAL" : undefined;
    if (path.includes("\0")) return "EINVAL";
    if (!path) return "ENOENT";
    return new TextEncoder().encode(path).length > 4096 ? "ENAMETOOLONG" : undefined;
  }
  const fixture = networkFixture(overrides);
  return { ...fixture, paths, calls, failClose(code: string) { closeFailure = code; } };
}
