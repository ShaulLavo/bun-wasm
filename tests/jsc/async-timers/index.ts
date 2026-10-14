// Event loop ordering: sync, nextTick/microtasks, timers by deadline, intervals, async/await.
const log: string[] = [];
setTimeout(() => log.push("timeout 20"), 20);
setTimeout(() => log.push("timeout 0"), 0);
const t = setTimeout(() => log.push("cancelled"), 5);
clearTimeout(t);
queueMicrotask(() => log.push("microtask"));
Promise.resolve().then(() => log.push("promise"));
process.nextTick(() => log.push("nextTick"));
log.push("sync");

let ticks = 0;
const iv = setInterval(() => {
  ticks++;
  log.push(`interval ${ticks}`);
  if (ticks === 3) clearInterval(iv);
}, 7);

async function worker(name: string, ms: number) {
  await Bun.sleep(ms);
  log.push(`worker ${name}`);
  return name.toUpperCase();
}

(async () => {
  const results = await Promise.all([worker("b", 30), worker("a", 10)]);
  log.push(`all ${results.join(",")}`);
  const raced = await Promise.race([new Promise((r) => setTimeout(() => r("slow"), 50)), new Promise((r) => setTimeout(() => r("fast"), 1))]);
  log.push(`race ${raced}`);
  setTimeout(() => {
    console.log(log.join("\n"));
  }, 60);
})();
