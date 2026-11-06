// A imports B, then C; B imports A. B evaluates before C, as natively.
import './a.mjs';
console.log('main');
