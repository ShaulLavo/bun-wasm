const before = process.memoryUsage();
console.log("before first collection", before.heapUsed === before.heapTotal);
const first = Bun.gc(true);
console.log("gc result positive", first > 0);
console.log("heapUsed is the last collection", process.memoryUsage().heapUsed === first);
(globalThis as { retained?: unknown }).retained = Array.from({ length: 20000 }, (_, i) => ({ i }));
const second = Bun.gc(true);
console.log("retained allocation counted", second > first, process.memoryUsage().heapUsed === second);
(globalThis as { retained?: unknown }).retained = null;
