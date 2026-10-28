let reads = 0;
const parent = [
  { get x() { reads++; parent.length = 0; Bun.gc(true); return 1; } },
  { marker: 42 },
];
const converted = __jsc_test_convert(parent);
if (reads !== 1 || parent.length !== 0 || converted.length !== 2 ||
    converted[0].x !== 1 || converted[1].marker !== 42) {
  throw Error("array snapshot lost a captured value during getter GC");
}
console.log("captured second value survives getter GC");
