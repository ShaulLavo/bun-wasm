import { test } from "bun:test";
import { runLoopControls } from "./spidermonkey-loop-controls.ts";

test("SpiderMonkey inline getters preserve roots, Debugger behavior and frame balance", runLoopControls, 600_000);
