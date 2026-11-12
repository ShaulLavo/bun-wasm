// Writes to imported bindings: immutable, so they throw when they run.
import { value } from './dep.mjs';
import * as ns from './dep.mjs';
export function writeImport() { value = 5; }
export function updateImport() { value++; }
export function writeNamespace() { ns = 6; }
export const seen = value;
