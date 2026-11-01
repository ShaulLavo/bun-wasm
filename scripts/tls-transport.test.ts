import { afterEach, expect, test } from "bun:test";
import { adapter, type Step, type TlsSocket } from "../tests/fixtures/tls-client/adapter";

let active: ReturnType<typeof adapter> | undefined;
afterEach(() => { active?.cleanup(); active = undefined; });
function fixture() { active = adapter(); return active; }
function secure(state: ReturnType<typeof adapter>, socket: TlsSocket) {
  socket.on("error", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
}

test("adapter reserves synchronously inside a raw data callback and stops the old pump generation", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain();
  const observed: string[] = [];
  let tls: TlsSocket | undefined;
  raw.on("data", bytes => {
    observed.push(bytes.toString());
    tls = state.tls.connect({ socket: raw }); tls.on("error", () => {});
    tls.write("startup", () => {});
    expect(state.contexts).toHaveLength(0);
    expect(state.calls).toHaveLength(0);
    expect(raw._conn.ownership.state.kind).toBe("reserved");
  });
  raw.on("data", bytes => observed.push(`second ${bytes.toString()}`));
  state.callbacks();
  state.reads.push(Buffer.from("S"), new Uint8Array([22, 3, 3]));
  const before = state.counters.reads;
  state.pump();
  expect(observed).toEqual(["S", "second S"]);
  expect(state.counters.reads - before).toBe(1);
  expect(state.contexts).toHaveLength(0);
  state.callbacks(); state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(tls?.authorized).toBe(true);
  expect(observed).toEqual(["S", "second S"]);
});

test("adapter rejects duplicate wrapping and all old-shell I/O without closing the TLS owner", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain();
  const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
  for (const action of [() => state.tls.connect({ socket: raw }), () => raw.write("plaintext"), () => raw.read(), () => raw.connect(443), () => raw.end(), () => raw.resume()]) expect(action).toThrow(expect.objectContaining({ code: "ERR_TLS_SOCKET_OWNERSHIP" }));
  expect(socket.destroyed).toBe(false);
  raw.destroy(); state.callbacks();
  expect(socket.destroyed).toBe(true);
  expect(state.counters.closes).toBe(1);
  expect(() => raw.connect(443)).toThrow(expect.objectContaining({ code: "ERR_TLS_SOCKET_OWNERSHIP" }));
});

test("adapter drains every pre-reservation plaintext write before the first TLS operation", () => {
  const state = fixture();
  const raw = state.plain();
  state.state.credit = 0;
  const completed: string[] = [];
  raw.write("SSLRequest-1", () => completed.push("one"));
  raw.write("SSLRequest-2", () => completed.push("two"));
  const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
  socket.write("startup", () => {});
  state.callbacks(); state.pump(); state.callbacks();
  expect(state.contexts).toHaveLength(0);
  state.state.credit = 100;
  state.pump(); state.callbacks();
  expect(completed).toEqual(["one", "two"]);
  expect(Buffer.concat(state.writes).toString()).toBe("SSLRequest-1SSLRequest-2");
  expect(state.contexts).toHaveLength(1);
  expect(state.calls.filter(call => call.event.kind === "plaintext")).toHaveLength(0);
});

test("adapter preserves ordinary multiple preconnect net writes in FIFO order", () => {
  const state = fixture();
  const raw = state.plain(false);
  const completed: number[] = [];
  raw.write("one", () => completed.push(1)); raw.write("two", () => completed.push(2)); raw.write("three", () => completed.push(3));
  state.state.tcpReady = true;
  state.pump(); state.callbacks();
  expect(completed).toEqual([1, 2, 3]);
  expect(Buffer.concat(state.writes).toString()).toBe("onetwothree");
});

test("adapter rejects a connecting wrap with pending plaintext before ownership changes", () => {
  const state = fixture();
  const raw = state.plain(false);
  raw.write("one"); raw.write("two");
  expect(() => state.tls.connect({ socket: raw })).toThrow(expect.objectContaining({ code: "ERR_TLS_SOCKET_OWNERSHIP" }));
  expect(raw._tlsTransferred).not.toBe(true);
  state.state.tcpReady = true; state.pump(); state.callbacks();
  expect(Buffer.concat(state.writes).toString()).toBe("onetwo");
});

test("adapter rejects pending final on a connecting socket without consuming it", () => {
  const state = fixture();
  const raw = state.plain(false); raw.end();
  expect(() => state.tls.connect({ socket: raw })).toThrow(expect.objectContaining({ code: "ERR_TLS_SOCKET_OWNERSHIP" }));
  expect(raw._tlsTransferred).not.toBe(true);
  state.state.tcpReady = true; state.pump(); state.callbacks();
  expect(state.counters.shutdowns).toBe(1);
});

test("adapter wraps an empty connecting socket and queues new writes through verification", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain(false);
  const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
  let written = false; socket.write("startup", () => { written = true; });
  state.callbacks(); state.pump();
  expect(state.contexts).toHaveLength(0);
  state.state.tcpReady = true;
  state.pump(); state.callbacks(); state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(socket.authorized).toBe(true);
  expect(written).toBe(true);
});

test("adapter takes unshifted and queued unread bytes in stream order after callback unwind", () => {
  const state = fixture();
  const raw = state.plain();
  let socket: TlsSocket | undefined;
  raw.on("data", bytes => {
    expect(bytes.toString()).toBe("S-prefix");
    raw.unshift(Buffer.from("first"));
    socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
    raw.unshift(Buffer.from("second"));
    expect(state.calls).toHaveLength(0);
  });
  state.callbacks(); state.reads.push(Buffer.from("S-prefix")); state.pump(); state.callbacks(); state.pump();
  expect(state.calls[0]?.event).toEqual({ kind: "ciphertext", data: Buffer.from("secondfirst") });
  expect(raw.readableLength).toBe(0);
  expect(socket).toBeDefined();
});

test("adapter write completion follows accepted, committed and raw acknowledged fences", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); secure(state, socket);
  state.state.credit = 0;
  let polled = 0;
  let accepted = false;
  state.respond(event => {
    if (event.kind === "plaintext") { accepted = true; return { kind: "progress", acceptedPlaintext: event.data?.length ?? 0, pendingPlaintext: 5 }; }
    if (accepted && polled++ < 2) return { pendingPlaintext: 5 };
    if (accepted) { accepted = false; return { kind: "progress", committedPlaintext: 5, ciphertext: new Uint8Array([1, 2, 3, 4, 5, 6]), writeCiphertextEnd: state.state.emitted + 6 }; }
    return {};
  });
  let written = 0; socket.write("hello", () => written++);
  state.pump(3); state.callbacks();
  expect(state.calls.filter(call => call.event.kind === "plaintext")).toHaveLength(1);
  expect(written).toBe(0);
  state.state.credit = 2; state.pump(); state.callbacks();
  expect(written).toBe(0);
  state.state.credit = 4; state.pump(); state.callbacks();
  expect(written).toBe(1);
});

test("adapter chunks long writes into bounded native records and does not copy a second raw queue", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); secure(state, socket);
  const bytes = Buffer.alloc(40000, 7);
  state.state.credit = 0;
  socket.write(bytes, () => {});
  state.pump(10);
  expect(state.calls.filter(call => call.event.kind === "plaintext")).toHaveLength(1);
  expect(Reflect.get(socket._conn, "raw").queue).toHaveLength(1);
  state.state.credit = 100000;
  for (let count = 0; count < 6; count++) { state.pump(); state.callbacks(); }
  const sizes = state.calls.filter(call => call.event.kind === "plaintext").map(call => call.event.data?.length);
  expect(sizes).toEqual([16384, 16384, 7232]);
  expect(Buffer.concat(state.writes)).toEqual(bytes);
});

test("adapter read pressure stops plaintext production and raw ingress until demand resumes", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, readableHighWaterMark: 4 }); secure(state, socket);
  let delivered = false;
  state.respond((_event, allowance) => {
    if (delivered || !allowance.plaintext) return {};
    delivered = true;
    return { kind: "progress", plaintext: new Uint8Array([1, 2, 3, 4]) };
  });
  state.pump();
  expect(socket.readableLength).toBe(4);
  const before = state.counters.reads;
  state.reads.push(new Uint8Array([22, 3, 3])); state.pump(3);
  expect(state.counters.reads).toBe(before);
  expect(socket.read()).toEqual(Buffer.from([1, 2, 3, 4]));
  state.pump();
  expect(state.counters.reads).toBeGreaterThan(before);
});

test("adapter fences close-notify acknowledgement before raw FIN and keeps the read half", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, allowHalfOpen: true }); secure(state, socket);
  state.state.credit = 0;
  state.respond(event => event.kind === "shutdown-write" ? { kind: "progress", ciphertext: new Uint8Array([21, 1]), shutdownCiphertextEnd: state.state.emitted + 2, writeClosed: true } : { writeClosed: true });
  let finished = 0; socket.end(() => finished++);
  state.pump(); state.callbacks();
  expect(state.counters.shutdowns).toBe(0);
  expect(finished).toBe(0);
  state.state.credit = 2; state.pump(); state.callbacks();
  expect(state.counters.shutdowns).toBe(1);
  expect(finished).toBe(1);
  expect(socket.destroyed).toBe(false);
});

test("adapter reports raw FIN without close-notify as a TLS error rather than clean EOF", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); secure(state, socket);
  const failures: Error[] = []; let ended = 0;
  socket.on("error", value => failures.push(value)); socket.on("end", () => ended++);
  state.respond(event => event.kind === "transport-eof" ? { kind: "failed", error: { code: "ERR_TLS_UNEXPECTED_EOF", message: "TLS close-notify missing", libraryCodes: [] } } : {});
  state.reads.push(0); state.pump(); state.pump(); state.callbacks();
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ code: "ERR_TLS_UNEXPECTED_EOF" });
  expect(ended).toBe(0);
});

test("adapter cancellation owns paused unreferenced sockets for their entire lifetime", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); secure(state, socket);
  socket.pause(); socket.unref();
  expect(state.internal.ioPending()).toBe(0);
  expect(Array.from(state.waiters).some(waiter => waiter.ref === false && typeof waiter.cancel === "function")).toBe(true);
  state.cancel(); state.pump();
  expect(socket.destroyed).toBe(true);
  expect(state.counters.closes).toBe(1);
  expect(state.waiters.size).toBe(0);
});

test("adapter bounds native work per pump and ignores stale output callbacks after destruction", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); secure(state, socket);
  state.respond((): Partial<Step> => ({ kind: "progress", consumedCiphertext: 1 }));
  const before = state.calls.length;
  state.pump();
  expect(state.calls.length - before).toBeLessThanOrEqual(16);
  state.handshake();
  state.state.credit = 0;
  let callbacks = 0; socket.write("hello", () => callbacks++);
  state.pump(); socket.destroy(); state.callbacks();
  state.state.credit = 100; state.pump(); state.callbacks();
  expect(callbacks).toBe(1);
  expect(state.counters.closes).toBe(1);
});

test("adapter cancellation during TCP connect and inside verification is terminal", () => {
  const state = fixture();
  const raw = state.plain(false);
  const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
  socket.unref(); socket.pause();
  state.cancel(); state.state.tcpReady = true; state.pump(); state.callbacks();
  expect(state.contexts).toHaveLength(0);
  expect(socket.destroyed).toBe(true);
  expect(state.counters.closes).toBe(1);
});

test("adapter cancellation from the identity callback cannot accept or restart the session", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443, checkServerIdentity() { state.internal.cancelIoWaiters(); } });
  socket.on("error", () => {}); socket.write("startup", () => {});
  state.pump(); state.callbacks(); state.pump(); state.callbacks(); state.pump();
  expect(state.decisions).toHaveLength(0);
  expect(socket.destroyed).toBe(true);
  expect(state.waiters.size).toBe(0);
});

test("adapter settles active and queued application writes once when canceled under raw pressure", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); secure(state, socket);
  state.state.credit = 0;
  const completed: (Error | null | undefined)[] = [];
  socket.write("one", error => completed.push(error)); socket.write("two", error => completed.push(error));
  state.pump(); state.cancel(); socket.destroy(); state.callbacks(); state.pump();
  expect(completed).toHaveLength(2);
  expect(completed.every(error => error instanceof Error)).toBe(true);
  expect(state.counters.closes).toBe(1);
  expect(state.releases.filter(([kind]) => kind === "connection")).toHaveLength(1);
});

test("adapter waits for a fence beyond the current native output batch", () => {
  const state = fixture(); state.handshake();
  const socket = state.tls.connect({ host: "fixture.test", port: 443 }); secure(state, socket);
  let draining = false;
  state.respond(event => {
    if (event.kind === "plaintext") { draining = true; return { kind: "progress", acceptedPlaintext: 1, committedPlaintext: 1, ciphertext: new Uint8Array([1]), writeCiphertextEnd: 2 }; }
    if (draining) { draining = false; return { kind: "progress", ciphertext: new Uint8Array([2]) }; }
    return {};
  });
  let completed = 0; socket.write("x", () => completed++);
  state.pump(); state.callbacks();
  expect(completed).toBe(0);
  state.pump(); state.callbacks();
  expect(completed).toBe(1);
  expect(Buffer.concat(state.writes)).toEqual(Buffer.from([1, 2]));
});

test("adapter preserves unref on a supplied socket and prevents old-shell ref or timeout changes", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain(); raw.unref();
  const socket = state.tls.connect({ socket: raw, handshakeTimeout: 500 }); socket.on("error", () => {});
  expect(state.internal.ioPending()).toBe(0);
  expect(Array.from(state.timers).every(timer => !timer.referenced)).toBe(true);
  for (const action of [() => raw.ref(), () => raw.unref(), () => raw.setTimeout(10)]) expect(action).toThrow(expect.objectContaining({ code: "ERR_TLS_SOCKET_OWNERSHIP" }));
  state.callbacks(); state.pump(); state.callbacks();
  expect(state.internal.ioPending()).toBe(0);
});

test("adapter reservation does not invoke user pause callbacks during construction", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain();
  let pause = 0;
  raw.on("pause", () => { pause++; raw.destroy(); });
  const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
  expect(pause).toBe(0);
  expect(socket.destroyed).toBe(false);
  state.callbacks(); state.pump(); state.callbacks();
  expect(socket.authorized).toBe(true);
});

test("adapter retains transport close bookkeeping without forwarding its errors to the old shell", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain();
  let bookkeeping = 0;
  let oldErrors = 0;
  const previous = Reflect.get(raw._conn, "onClose");
  Reflect.set(raw._conn, "onClose", () => { bookkeeping++; previous?.(); });
  raw.on("error", () => oldErrors++);
  const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
  state.callbacks(); state.pump(); state.callbacks();
  socket.destroy(new Error("adapter failure")); state.callbacks(); state.pump();
  expect(bookkeeping).toBe(1);
  expect(oldErrors).toBe(0);
  expect(state.counters.closes).toBe(1);
});

test("adapter reentrant waiter and tick pumping cannot start TLS while the raw callback is on the stack", () => {
  const state = fixture(); state.handshake();
  const raw = state.plain();
  raw.on("data", () => {
    const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
    socket.write("startup", () => {});
    state.callbacks(); state.pump(); state.callbacks();
    expect(state.contexts).toHaveLength(0);
    expect(state.calls).toHaveLength(0);
    expect(state.ticks).toHaveLength(0);
  });
  state.callbacks(); state.reads.push(Buffer.from("S")); state.pump();
  state.callbacks(); state.pump(); state.callbacks();
  expect(state.contexts).toHaveLength(1);
});

test("adapter failed session allocation releases the temporary context and raw owner once", () => {
  const state = fixture();
  state.native.tlsCreateConnection = () => { throw Object.assign(new Error("adapter context failure"), { code: "ERR_TLS_CONTEXT" }); };
  const socket = state.tls.connect({ host: "fixture.test", port: 443 });
  const errors: Error[] = []; socket.on("error", error => errors.push(error));
  state.pump(); state.callbacks(); state.pump(); state.callbacks();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "ERR_TLS_CONTEXT" });
  expect(state.releases).toEqual([["context", 1]]);
  expect(state.counters.closes).toBe(1);
});

test("adapter ClientHello marker waits for callback unwind and the next raw record stays TLS-owned", () => {
  const state = fixture();
  const raw = state.plain();
  let insidePlaintext = false;
  let hello = false;
  let verified = false;
  const plain: string[] = [];
  const write = state.native.hostWrite;
  state.native.hostWrite = (handle, bytes) => {
    if (bytes.length) expect(insidePlaintext).toBe(false);
    return write(handle, bytes);
  };
  state.respond(event => {
    if (!hello) { hello = true; return { kind: "progress", ciphertext: new Uint8Array([22, 1]) }; }
    if (!verified && event.kind === "ciphertext") {
      verified = true;
      return { kind: "verification-required", acceptedCiphertext: event.data?.length ?? 0, consumedCiphertext: event.data?.length ?? 0, peer: state.state.peer };
    }
    return {};
  });
  raw.on("data", bytes => {
    insidePlaintext = true;
    plain.push(bytes.toString());
    const socket = state.tls.connect({ socket: raw }); socket.on("error", () => {});
    state.pump(); state.callbacks();
    expect(hello).toBe(false);
    insidePlaintext = false;
  });
  state.callbacks(); state.reads.push(Buffer.from("S"), new Uint8Array([22, 2]));
  state.pump(); state.callbacks(); state.pump(); state.callbacks(); state.pump(); state.callbacks();
  state.pump(); state.callbacks();
  expect(hello).toBe(true);
  expect(verified).toBe(true);
  expect(plain).toEqual(["S"]);
  expect(Buffer.concat(state.writes)).toEqual(Buffer.from([22, 1]));
});
