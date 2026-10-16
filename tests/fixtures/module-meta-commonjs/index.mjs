for (const name of ['meta-require.js', 'meta-dirname.js', 'meta-await.js', 'meta-typescript.ts', 'arity.cjs']) {
  try { await import('./' + name); }
  catch (error) { console.log('FAIL', name, error.name); }
}
