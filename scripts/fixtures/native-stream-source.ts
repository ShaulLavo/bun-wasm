import { readFileSync } from "node:fs";

export function nativeStreamBridgeSource(): string {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const sources = ["native-direct-stream", "native-readable-iterator", "native-stream-state"].map(name => {
    const source = readFileSync(new URL(`../../web/src/${name}.ts`, import.meta.url), "utf8");
    return transpiler.transformSync(source).replace(/^import .*;$/gm, "").replaceAll("export function", "function");
  });
  return `${sources.join("\n")}\nreturn installNativeStreamState();`;
}
