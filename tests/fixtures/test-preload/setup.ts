import { beforeAll } from "bun:test";
import { heapStats } from "bun:jsc";
import { isASANEnabled } from "bun:internal-for-testing";
const stats = heapStats();
globalThis.preloadLoaded = typeof stats.heapSize === "number" && typeof stats.objectTypeCounts === "object" && !isASANEnabled();
beforeAll(() => { globalThis.preloadHookRan = true; });
