const a = { import(x) { return x; } };
module.exports = () => {
  const computed = "./value.mjs";
  return Promise.all([
    import("./value.mjs"),
    import(computed),
    import(`./${"value"}.mjs`),
  ]).then(([first, second, third]) => [a.import(first.value), second.value, `${third.value}`].join(" "));
};
