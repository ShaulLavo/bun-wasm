import { expect, test } from "bun:test";
import { firstError } from "./classify.mjs";

test("system errors in framework logs retain their diagnostic", () => {
  expect(firstError('1 | import.meta.require("ws")\nENOENT: no such file or directory, open \'ws\'\n    at /vite/config.js:23728:63')).toBe("ENOENT: no such file or directory, open 'ws'");
});
