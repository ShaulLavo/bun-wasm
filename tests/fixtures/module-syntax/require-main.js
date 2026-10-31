async function load() {
  await Promise.resolve();
}
module.exports = { main: require.main === module, value: 'require main', load };
