import { callerSourceOrigin } from "bun:jsc";

export function origin() { return callerSourceOrigin(); }
