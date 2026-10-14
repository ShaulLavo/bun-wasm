// An uncaught error prints to stderr and exits 1; stdout written before it stays.
console.log("before");
function fail(): never {
  throw new TypeError("bad things happened");
}
setTimeout(() => {
  console.log("in timer");
  fail();
}, 1);
