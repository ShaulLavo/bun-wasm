// Rust CLI commands run synchronously before the host JS engine starts. Keep
// their fetches on a worker so WASI poll can wait without blocking Node I/O.
import { memoryViews } from "waffle/core/memory-views";
import { MessageChannel, Worker, receiveMessageOnPort, workerData } from "node:worker_threads";
import { packageFetch } from "../src/net/package-fetch.ts";

const AGAIN = -2;
const ERROR = -1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LIMIT = 256 * 1024 * 1024;

if (workerData?.installFetch) serve(workerData);

function serve({ port, wake }) {
  const signal = wake;
  const requests = new Map();
  function reply(message, transfer = []) {
    port.postMessage(message, transfer);
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
  async function fetchRequest(message) {
    const controller = new AbortController();
    requests.set(message.id, controller);
    try {
      const fetcher = message.meta.credentialPolicy === "package" ? packageFetch : fetch;
      const response = await fetcher(message.meta.url, {
        method: message.meta.method, headers: message.meta.headers,
        redirect: message.meta.redirect, signal: controller.signal,
        body: message.body.length ? message.body : undefined,
      });
      const chunks = [];
      let size = 0;
      for await (const bytes of response.body ?? []) {
        size += bytes.length;
        if (size > LIMIT) throw new Error("Download exceeds 256 MiB limit");
        chunks.push(bytes);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const bytes of chunks) { body.set(bytes, offset); offset += bytes.length; }
      reply({ id: message.id, head: { status: response.status, statusText: response.statusText, url: response.url,
        redirected: response.redirected, headers: Array.from(response.headers) }, body }, [body.buffer]);
    } catch (error) {
      reply({ id: message.id, error: { name: "TypeError", message: error.message } });
    } finally { requests.delete(message.id); }
  }
  port.on("message", message => {
    if (message.close) requests.get(message.id)?.abort();
    else void fetchRequest(message);
  });
}

/** Installs only the synchronous fetch slots; the JS engine keeps node-net.mjs. */
export function installCliFetch(imports, getInstance, wake = new Int32Array(new SharedArrayBuffer(4))) {
  const { port1, port2 } = new MessageChannel();
  let worker;
  let next = 1;
  const handles = new Map();
  let memory;
  const views = () => (memory ??= memoryViews(getInstance().exports.memory));
  const bytes = (ptr, length) => views().range(ptr, length);
  function drain() {
    let changed = false;
    for (let packet; (packet = receiveMessageOnPort(port1));) {
      const state = handles.get(packet.message.id);
      if (state) Object.assign(state, packet.message);
      changed = true;
    }
    return changed;
  }
  function start(meta, body) {
    worker ??= new Worker(new URL(import.meta.url), { workerData: { installFetch: true, port: port2, wake }, transferList: [port2] });
    const id = next++;
    if (process.env.BUN_WASM_TRACE || process.env.WASI_TRACE) process.stderr.write(`[bun_wasm] fetch(${body.length} body bytes) -> ${id}\n`);
    handles.set(id, { offset: 0 });
    port1.postMessage({ id, meta, body });
    return id;
  }
  function textResult(value, ptr, cap) {
    if (value === undefined) return AGAIN;
    const data = encoder.encode(JSON.stringify(value));
    if (data.length <= cap) bytes(ptr, data.length).set(data);
    return data.length;
  }
  function call(slot, a, b, c, d) {
    if (slot === 0) {
      if (drain()) return 1;
      const version = Atomics.load(wake, 0);
      if (drain()) return 1;
      Atomics.wait(wake, 0, version, a < 0 ? undefined : a);
      return drain() ? 1 : 0;
    }
    if (slot === 1) return start(JSON.parse(decoder.decode(bytes(a, b))), bytes(c, d).slice());
    drain();
    const state = handles.get(a);
    if (!state) return -3;
    if (slot === 10) return textResult(state.error, b, c);
    if (slot === 5) { handles.delete(a); port1.postMessage({ id: a, close: true }); return 0; }
    if (state.error) return ERROR;
    if (slot === 2) return textResult(state.head, b, c);
    if (!state.body) return AGAIN;
    const piece = state.body.subarray(state.offset, state.offset + c);
    bytes(b, piece.length).set(piece);
    state.offset += piece.length;
    return piece.length;
  }
  const original = imports.wasi_snapshot_preview1.sock_send;
  imports.wasi_snapshot_preview1.sock_send = (fd, packet, count, flags, result) => {
    if (fd !== 0x7fffb0b0) return original(fd, packet, count, flags, result);
    const view = views().view();
    const slot = view.getInt32(packet, true);
    if (![0, 1, 2, 3, 5, 10].includes(slot)) return original(fd, packet, count, flags, result);
    const value = call(slot, view.getInt32(packet + 4, true), view.getInt32(packet + 8, true),
      view.getInt32(packet + 12, true), view.getInt32(packet + 16, true));
    views().view().setInt32(result, value, true);
    return 0;
  };
  return {
    call,
    install() {
      const pointer = getInstance().exports.bun_wasm_host_slots();
      const view = views().view();
      for (const slot of [0, 1, 2, 3, 5, 10]) view.setUint32(pointer + 8 + slot * 4, 0xffffffff, true);
    },
    dispose() { port1.close(); if (!worker) port2.close(); void worker?.terminate(); },
  };
}
