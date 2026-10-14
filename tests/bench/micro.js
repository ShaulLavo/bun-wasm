// Engine micro-benchmark: tight loop, RegExp, JSON, allocation. Prints one line per section
// with its wall time; run by scripts/bench-jsc.sh under both engines.
function time(name, fn) {
  const t0 = performance.now();
  const result = fn();
  console.log(`${name.padEnd(8)} ${String(Math.round(performance.now() - t0)).padStart(6)} ms  (${result})`);
}

time("loop", () => {
  let s = 0;
  const o = { x: 0 };
  const add = (a, b) => a + b;
  for (let i = 0; i < 3_000_000; i++) {
    s = add(s, i & 1023);
    o.x = s % 7;
  }
  return s + o.x;
});

time("regexp", () => {
  const re = /(\w+)@(\w+)\.(com|org|net)/g;
  const text = Array.from({ length: 2000 }, (_, i) => `user${i}@host${i % 50}.${["com", "org", "net"][i % 3]} filler text ${i}`).join("\n");
  let n = 0;
  for (let r = 0; r < 20; r++) {
    for (const m of text.matchAll(re)) n += m[2].length;
    n += text.replace(/\d+/g, "#").length;
  }
  return n;
});

time("json", () => {
  const data = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ["a", "b", String(i % 10)], nested: { ok: i % 2 === 0, score: i / 7 } }));
  let n = 0;
  for (let r = 0; r < 10; r++) {
    const text = JSON.stringify(data);
    n += JSON.parse(text).length + text.length;
  }
  return n;
});

time("alloc", () => {
  let total = 0;
  for (let r = 0; r < 20; r++) {
    const arr = [];
    for (let i = 0; i < 50_000; i++) arr.push({ i, s: "v" + i, a: [i, i + 1] });
    const m = new Map();
    for (let i = 0; i < 20_000; i++) m.set("k" + i, arr[i]);
    total += arr.reduce((acc, o) => acc + o.a[1] - o.i, 0) + m.size;
  }
  return total;
});

time("strings", () => {
  const words = [];
  for (let i = 0; i < 20_000; i++) words.push("w" + ((i * 7919) % 1000));
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Object.keys(counts).length + words.sort().join(",").length;
});
