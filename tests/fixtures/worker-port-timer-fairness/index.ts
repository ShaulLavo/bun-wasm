import { MessageChannel } from "node:worker_threads";

await new Promise<void>((resolve, reject) => {
  const { port1, port2 } = new MessageChannel();
  let iterations = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  port1.on("message", () => {
    if (++iterations > 10000) {
      clearTimeout(timer);
      port1.close(); port2.close();
      reject(new Error("MessagePort starved its timer"));
      return;
    }
    if (iterations === 1) timer = setTimeout(() => { port1.close(); port2.close(); resolve(); }, 0);
    port2.postMessage("again");
  });
  port2.postMessage("start");
});
console.log("MessagePort loop yields to timers");
