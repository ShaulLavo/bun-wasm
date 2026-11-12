// Writes to a constant: valid module syntax that throws when it runs.
export const value = 1;
export function change() { value = 2; }
export function neverCalled() { value = 3; }
if (false) value = 4;
