const fs = require("node:fs");
const fd = Number(process.argv[2]);
const stream = fd === 1 ? process.stdout : process.stderr;
const rows = [];
let previousError;

function state(label, error, firstError) {
  rows.push([label, stream.writable, stream.destroyed, error ? error === firstError : null]);
}

function batch(round) {
  let firstError;
  state(`initial${round}`);
  stream.once("error", error => {
    state(`event${round}`, error, firstError);
  });
  for (let i = 0; i < 3; i++) {
    const returned = stream.write("x".repeat(65536), error => {
      if (i === 0) {
        firstError = error;
        rows.push(["error", error.code, error.errno, error.syscall, error !== previousError]);
        previousError = error;
      }
      state(`callback${round}.${i}`, error, firstError);
      process.nextTick(() => state(`tick${round}.${i}`));
    });
    rows.push(["returned", returned]);
    state(`write${round}.${i}`);
  }
  setTimeout(() => {
    state(`survived${round}`);
    if (round === 0) batch(1);
    else fs.writeSync(fd === 1 ? 2 : 1, JSON.stringify(rows) + "\n");
  }, 30);
}

batch(0);
