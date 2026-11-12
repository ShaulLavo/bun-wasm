import { readFileSync } from "node:fs";

function bunTransform(): (source: string) => string {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  return source => transpiler.transformSync(source);
}

export function nativeStreamBridgeSource(transform = bunTransform()): string {
  const entries = [["native-direct-stream", "constructNativeReadable"], ["native-readable-iterator", "installReadableStreamIteration"], ["native-stream-state", "installNativeStreamState"]] as const;
  const sources = entries.map(([name, exported]) => {
    const source = readFileSync(new URL(`../../web/src/${name}.ts`, import.meta.url), "utf8");
    const body = transform(source).replace(/^import .*;$/gm, "").replaceAll("export function", "function");
    return `const ${exported} = (() => {\n${body}\nreturn ${exported};\n})();`;
  });
  return `${sources.join("\n")}\nreturn installNativeStreamState();`;
}
