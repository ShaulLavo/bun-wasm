import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { routingObservationSource, verifyRoutingInstallation } from "./storage-routing-build";

function replace(source: string, needle: string, replacement: string): string {
  if (source.split(needle).length !== 2) throw Error(`Storage observation seam changed: ${needle}`);
  return source.replace(needle, replacement);
}
export function storageObservationSource(path: string, source: string): string | undefined {
  const adapter = JSON.stringify(resolve(import.meta.dir, "storage-fs-observation.ts"));
  const prelude = `import ${JSON.stringify(resolve(import.meta.dir, "storage-fs-worker-prelude.ts"))};\n`;
  const imported = `import { observeProcess, observeEndpoint, qualifyEndpoint, checkEndpoint, bindRuntime, associateFilesystem, observePreview1Branch } from ${adapter};\n`;
  let output: string;
  if (/\/(?:sandbox|web)\/src\/main\.ts$/.test(path)) output = `import ${JSON.stringify(resolve(import.meta.dir, "storage-fs-page-prelude.ts"))};\n` + source;
  else if (/\/web\/src\/(?:worker|preview1-worker)\.ts$/.test(path)) {
    output = replace(source, "const request = event.data;", 'const request = event.data; observeProcess(request, ' + JSON.stringify(path.endsWith("/preview1-worker.ts") ? "preview1" : "bun") + ');');
    if (path.endsWith("/preview1-worker.ts")) output = replace(output, "    : preview1Executor;", "    : preview1Executor;\n  observePreview1Branch(Boolean(interactive));");
    output = prelude + output;
  } else if (path.endsWith("/bash-web/src/runtime/worker.ts")) {
    output = replace(source, "host.onmessage = (event) => bootstrap(event.data, shellExecutor(event.data));", 'host.onmessage = (event) => { observeProcess(event.data, "shell"); return bootstrap(event.data, shellExecutor(event.data)); };');
    output = prelude + output;
  } else if (path.endsWith("/web/src/fs-worker.ts")) output = prelude + source;
  else if (path.endsWith("/waffle/runtime.ts")) {
    output = replace(source, "  return Object.freeze(runtime);", "  bindRuntime(runtime, filesystem.client.connection.shared);\n  return Object.freeze(runtime);");
  } else if (path.endsWith("/waffle/browser/shared-fs.ts")) {
    const method = "  connect(identity: FilesystemIdentity, headroom: Headroom | null = null): FilesystemConnection {";
    output = replace(source, method, method + "\n    associateFilesystem(this.client.connection.shared, identity.shared);");
  } else if (path.endsWith("/waffle/fs/client.ts")) {
    output = replace(source, "    this.requests = new FilesystemRequestAllocator(connection.requests);", '    observeEndpoint(connection, "client");\n    this.requests = new FilesystemRequestAllocator(connection.requests);');
    output = replace(output, "    connection.port.start();", "    qualifyEndpoint(connection);\n    connection.port.start();");
    output = replace(output, "  transportError() {", "  transportError() {\n    checkEndpoint(this.connection);");
  } else if (path.endsWith("/waffle/fs/service.ts")) {
    output = replace(source, "  connect(connection: FilesystemConnection): void {", '  connect(connection: FilesystemConnection): void {\n    observeEndpoint(connection, "service");');
    output = replace(output, "    connection.port.start();", "    qualifyEndpoint(connection);\n    connection.port.start();");
  } else return routingObservationSource(path, source);
  const routing = routingObservationSource(path, output);
  return imported + (routing ?? output);
}
export function storageObservationPlugin(runtimePath: () => string): Bun.BunPlugin {
  return { name: "storage-first-event", setup(build) {
    verifyRoutingInstallation(runtimePath());
    // The helper is private consumer code. Resolve its private type/implementation imports
    // through this app's exact installation, including Sandbox and shell builds.
    build.onResolve({ filter: /node_modules\/waffle\// }, ({ path }) => ({ path: Bun.resolveSync("./" + path.split("node_modules/waffle/")[1]!, runtimePath()) }));
    build.onLoad({ filter: /(?:\/(?:web|sandbox)\/src\/(?:main|sandbox|sw|preview|worker|preview1-worker|fs-worker)|\/bash-web\/src\/runtime\/worker|\/waffle\/(?:runtime|browser\/(?:shared-fs|preview|service-worker|net\/(?:helper|runtime))|fs\/(?:client|service)))\.ts$/ }, ({ path }) => {
      const contents = storageObservationSource(path, readFileSync(path, "utf8"));
      return contents === undefined ? undefined : { contents, loader: "ts" };
    });
  } };
}
