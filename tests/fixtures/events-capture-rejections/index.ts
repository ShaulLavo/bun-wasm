import EventEmitter from "node:events";
import { captureCases, thenableCases } from "./cases.ts";

await captureCases(EventEmitter);
await thenableCases(EventEmitter);
