import { test } from "bun:test";

const root = import.meta.dir;
const prefix = root.endsWith("/") ? root : `${root}/`;
function frames(error: Error) {
  return String(error.stack).split(prefix).join("./");
}

test("stack inside a test", () => {
  console.log(frames(new Error("in test")));
});

test("stack inside an async test", async () => {
  await null;
  console.log(frames(new Error("in async test")));
});
