export const VERSION = "1.0.0";
export default class Stack<T> {
  private items: T[] = [];
  push(item: T) { this.items.push(item); }
  pop(): T | undefined { return this.items.pop(); }
  get size() { return this.items.length; }
}
