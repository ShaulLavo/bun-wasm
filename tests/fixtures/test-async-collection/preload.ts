import { beforeAll } from "bun:test";
import { delay, note } from "./note.ts";
note("preload enter");
await delay();
note("preload resume");
beforeAll(() => note("preload beforeAll"));
