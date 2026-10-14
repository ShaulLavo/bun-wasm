console.log("before");
function explode() {
  throw new TypeError("kaboom");
}
setTimeout(() => console.log("never printed"), 10);
explode();
