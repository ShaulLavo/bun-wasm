import { render } from "./components/view.tsx";
import config from "./settings.toml";

interface User {
  name: string;
  age?: number;
}
enum Level {
  Low = 1,
  High = 10,
}
type Pair<T> = [T, T];
const pair: Pair<number> = [1, 2];
function greet(user: User): string {
  return `${user.name} (${user.age ?? "?"})`;
}
class Box<T> {
  constructor(private readonly value: T) {}
  get(): T {
    return this.value;
  }
}
console.log(greet({ name: "Ada", age: 36 }), greet({ name: "Bob" }));
console.log("enum:", Level.High, Level[1]);
console.log("generic:", new Box<string>("boxed").get(), pair.length);
console.log("satisfies:", ({ a: 1 } satisfies Record<string, number>).a);
console.log("tsx:", render());
console.log("toml:", config.title, config.owner.name, config.ports.join(","));
