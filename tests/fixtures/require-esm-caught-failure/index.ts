for (const specifier of ["./throws.mjs", "./user-range.mjs"]) {
  try {
    require(specifier);
  } catch (error) {
    console.log(`${error.constructor.name}: ${error.message}`);
  }
}

console.log(`ok: ${require("./ok.mjs").value}`);
