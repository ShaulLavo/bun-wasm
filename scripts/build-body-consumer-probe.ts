import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bodyConsumerFactory, bodyConsumerSources } from "./body-consumer-factory.ts";

const out = resolve(process.argv[2] ?? "/work/reports/wave-20261106/engines/ssr-body-consumer/capability");
mkdirSync(out, { recursive: true });
const transpiler = new Bun.Transpiler({ loader: "ts" });
const controls = await Bun.file(new URL("../web/tests/body-consumer-capability.ts", import.meta.url)).text();
const factory = transpiler.transformSync(bodyConsumerFactory.toString());
const code = `${factory}\nconst sources = ${JSON.stringify(bodyConsumerSources())};\n${transpiler.transformSync(controls).replaceAll("export async function", "async function")}\n`;
const bridge = await Bun.build({ entrypoints: [new URL("../web/src/native-stream-state.ts", import.meta.url).pathname], target: "browser", format: "esm" });
if (!bridge.success) throw new Error(bridge.logs.map(String).join("\n"));
const adapter = (await bridge.outputs[0]!.text()).replace(/export\s*\{[^}]*\};?\s*$/, "");
const run = `const rows = await bodyConsumerCapability(sources, bodyConsumerFactory); const dispose = installNativeStreamState(); try { rows.push(...await bodyConsumerCapability(sources, bodyConsumerFactory, 'adapted')); } finally { dispose(); }`;
writeFileSync(join(out, "worker.js"), `${adapter}\n${code}\n${run}\npostMessage({ realm: 'worker', userAgent: navigator.userAgent, rows });`);
writeFileSync(join(out, "page.js"), `${adapter}\n${code}\n${run}\nconst result = { realm: 'page', userAgent: navigator.userAgent, rows }; globalThis.bodyConsumerResults = [result]; document.querySelector('pre').textContent = JSON.stringify(result, null, 2); const worker = new Worker('./worker.js', { type: 'module' }); worker.onmessage = ({data}) => { globalThis.bodyConsumerResults.push(data); document.querySelector('pre').textContent += '\\n' + JSON.stringify(data, null, 2); worker.terminate(); }; worker.onerror = error => { document.querySelector('pre').textContent += '\\nworker error: ' + error.message; worker.terminate(); };`);
writeFileSync(join(out, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Body reader capability</title><pre>Running page and worker controls</pre><script type="module" src="./page.js"></script>');
console.log(out);
