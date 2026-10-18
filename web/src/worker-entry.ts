/** Public module-worker entry. Bundle this entry, never import it into the page. */
import { bootstrap } from "waffle/browser/worker";
import { createBunExecutor, type RunRequest } from "./bun-executor.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<RunRequest>) => bootstrap(event.data, createBunExecutor(event.data, scope), scope);
