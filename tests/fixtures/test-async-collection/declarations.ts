import { test } from "bun:test";
import { delay, note } from "./note.ts";
note("module enter");
await delay();
note("module resume");
test("module declaration", () => note("must not replay"));
