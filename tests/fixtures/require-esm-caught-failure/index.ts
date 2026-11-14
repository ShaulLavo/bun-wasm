for (const specifier of ["./throws.mts", "./user-range.mts"]) {
  try {
    require(specifier);
  } catch (error) {
    console.log(`${error.constructor.name}: ${error.message}`);
  }
}

console.log(`ok: ${require("./ok.mts").value}`);
