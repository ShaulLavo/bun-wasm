// Exports named like Object.prototype members, and a string-named alias.
export const __proto__ = 1, constructor = 2, toString = 3;
const hidden = 4;
export { hidden as 'a-b', hidden as '__proto__x' };
