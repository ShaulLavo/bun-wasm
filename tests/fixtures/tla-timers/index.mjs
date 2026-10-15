// Top-level await on timers: the event loop must keep running timers while
// the entry module itself is still pending.
console.log("start");
await Bun.sleep(5);
console.log("after Bun.sleep");
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("after setTimeout");
await new Promise((resolve) => setImmediate(resolve));
console.log("after setImmediate");
const ticks = await new Promise((resolve) => {
  let n = 0;
  const iv = setInterval(() => {
    if (++n === 3) {
      clearInterval(iv);
      resolve(n);
    }
  }, 2);
});
console.log("interval ticks", ticks);
