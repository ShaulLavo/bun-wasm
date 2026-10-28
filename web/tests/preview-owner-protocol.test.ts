import { expect, test } from "bun:test";
import { ownerFrame } from "../src/preview-owner-protocol";

function socketOpen(url: string) {
  return JSON.stringify({ type: "open", id: "exchange", open: { type: "socket", url,
    authorization: { owner: crypto.randomUUID(), port: 3137, origin: "http://127.0.0.1:8888", capability: crypto.randomUUID() },
  } });
}

for (const url of [
  "blob:http://127.0.0.1:8888/fixture", "blob:ws://127.0.0.1:8888/fixture",
  "file:///fixture", "ftp://127.0.0.1:8888/fixture", "data:text/plain,fixture",
]) test(`owner socket framing rejects the ${new URL(url).protocol} scheme`, () => {
  let accepted = false;
  try { ownerFrame(socketOpen(url)); accepted = true; } catch {}
  expect(accepted).toBe(false);
});

for (const url of ["http://127.0.0.1:8888/socket", "ws://127.0.0.1:8888/socket"])
  test(`owner socket framing accepts the bound ${new URL(url).protocol} origin`, () => {
    expect(ownerFrame(socketOpen(url)).type).toBe("open");
  });
