import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import { portRefChecks } from "./checks";

portRefChecks();
const { port1, port2 } = new MessageChannel();
try {
  port2.unref();
  let inline = true;
  port2.addEventListener("message", () => { if (inline) throw new Error("inline delivery"); }, { once: true });
  const reply = once(port2, "message");
  port1.postMessage("received despite unref");
  inline = false;
  const [value] = await reply;
  if (value !== "received despite unref" || port2.hasRef()) throw new Error("unref delivery");
  console.log("port explicit unref still receives asynchronously");
} finally { port1.close(); port2.close(); }

const worker = new Worker(new URL("./worker.ts", import.meta.url));
try {
  const [data] = await once(worker, "message");
  if (JSON.stringify(data) !== "[false,false,true,false]") throw new Error("parent port ref " + JSON.stringify(data));
  console.log("worker forwarder excludes only its trusted identity");
} finally { await worker.terminate(); }
