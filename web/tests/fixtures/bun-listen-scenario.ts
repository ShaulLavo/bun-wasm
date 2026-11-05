// One scenario text for native Bun and the maintained bun_tcp adapter: a Bun.listen listener
// registered with `enterWith`, inside a scoped `run`, followed by unrelated ambient work, or at
// the root, and one Bun.connect client dialed inside its own scoped `run`. Every callback
// records the frame it sees. `tcp` is `Bun` or the adapter; `done` runs once both sides closed.

export type Kind = "enterWith" | "run" | "ambient" | "root";
export type Sites = Record<string, string | null>;
export const KINDS: Kind[] = ["enterWith", "run", "ambient", "root"];

export const SCENARIO = `(function (storage, tcp, kind, done) {
  const seen = {};
  const see = site => { seen[site] = storage.getStore() ?? null; };
  const settle = () => { if ("server close" in seen && "client close" in seen) done(); };
  const listen = () => tcp.listen({ hostname: "127.0.0.1", port: 0, socket: {
    open(socket) { see("server open"); socket.write("hi"); },
    data(socket) { see("server data"); socket.end(); },
    close() { see("server close"); settle(); },
    error(_socket, error) { throw error; },
  } });
  let listener;
  if (kind === "run") listener = storage.run("listen-frame", listen);
  else if (kind === "root") listener = listen();
  else { storage.enterWith("listen-frame"); listener = listen(); }
  if (kind === "ambient" || kind === "root") storage.enterWith("unrelated");
  const client = storage.run("dial-frame", () => tcp.connect({ hostname: "127.0.0.1", port: listener.port, socket: {
    open(socket) { see("client open"); socket.write("x"); },
    data() { see("client data"); },
    close() { see("client close"); settle(); },
    error(_socket, error) { throw error; },
  } }));
  return { seen, listener, client };
})`;

export const EXPECTED: Record<Kind, Sites> = {
  enterWith: { "server open": "listen-frame", "server data": "listen-frame", "server close": "listen-frame", "client open": "dial-frame", "client data": "dial-frame", "client close": "dial-frame" },
  run: { "server open": "listen-frame", "server data": "listen-frame", "server close": "listen-frame", "client open": "dial-frame", "client data": "dial-frame", "client close": "dial-frame" },
  ambient: { "server open": "listen-frame", "server data": "listen-frame", "server close": "listen-frame", "client open": "dial-frame", "client data": "dial-frame", "client close": "dial-frame" },
  root: { "server open": null, "server data": null, "server close": null, "client open": "dial-frame", "client data": "dial-frame", "client close": "dial-frame" },
};
