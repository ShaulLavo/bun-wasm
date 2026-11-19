// An ES module in TypeScript that throws while it loads, outside any function.
interface Config {
  name: string;
}

const config: Config = { name: "" };

export const name: string = config.name;
if (!name) throw new Error("config has no name");
