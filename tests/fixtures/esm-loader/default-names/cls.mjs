export default class {
  static seen = this.name;
  static { globalThis.blockName = this.name; }
}
