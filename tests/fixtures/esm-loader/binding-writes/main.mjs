// Constant and import binding writes fail at run time with a TypeError, not when loading
// (source review R5 follow-up).
const dep = await import('./dep.mjs');
console.log('loaded', dep.value);
const attempt = (name, f) => { try { f(); console.log(name, 'ok'); } catch (error) { console.log(name, error.constructor.name); } };
attempt('change', dep.change);
const importer = await import('./importer.mjs');
console.log('importer', importer.seen);
attempt('writeImport', importer.writeImport);
attempt('updateImport', importer.updateImport);
attempt('writeNamespace', importer.writeNamespace);
console.log('after', dep.value);
