class Filter {
  import(value) { this.value = value; }
}
const filter = new Filter();
filter.import(42);
console.log(filter.value);
