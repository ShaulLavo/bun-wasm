import('./importer.mjs').then(() => console.log('unexpected'), error => console.log(error.name));
