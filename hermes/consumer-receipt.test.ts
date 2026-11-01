// Dormant synthetic receipt regressions, excluded from normal publication qualification.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../scripts/guest-source-manifest.ts";
import { hermesConsumerReceipt, verifyHermesLibrary } from "./consumer-receipt.ts";

function hermesFixture(run: (root: string, receipt: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "producer-hermes-"));
  try {
    mkdirSync(join(root, "wasi/lib"), { recursive: true });
    mkdirSync(join(root, "crates/bunwasm-hermes/cpp"), { recursive: true });
    writeFileSync(join(root, "wasi/lib/libhermesvm_bunwasm.a"), "archive fixture");
    writeFileSync(join(root, "crates/bunwasm-hermes/cpp/shim.cpp"), '#include "memory-telemetry.h"\n');
    writeFileSync(join(root, "crates/bunwasm-hermes/cpp/memory-telemetry.h"), '#include "nested.h"\nstruct Telemetry { int old; };\n');
    writeFileSync(join(root, "crates/bunwasm-hermes/cpp/nested.h"), "// transitive dependency\n");
    writeFileSync(join(root, "wasi/generated.h"), "// generated dependency\n");
    const paths = ["crates/bunwasm-hermes/cpp/shim.cpp", "crates/bunwasm-hermes/cpp/memory-telemetry.h", "crates/bunwasm-hermes/cpp/nested.h", "wasi/generated.h"];
    writeFileSync(join(root, "wasi/shim-dependencies.txt"), `shim.cpp.o: #deps 4, deps mtime 1 (VALID)\n${paths.map(path => `    ${join(root, path)}`).join("\n")}\n\n`);
    writeFileSync(join(root, "original.json"), JSON.stringify({ sha256: hash("archive fixture"), bytes: 15, ...hermesConsumerReceipt(root, root) }));
    run(root, join(root, "original.json"));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("original native generation captures actual compiler header dependencies and is admitted", () => {
  hermesFixture((root, receipt) => {
    const original = readFileSync(receipt, "utf8");
    const captured = hermesConsumerReceipt(root, root);
    expect(captured.consumerInputs.inputs.map(input => input.path)).toContain("crates/bunwasm-hermes/cpp/memory-telemetry.h");
    expect(captured.consumerInputs.inputs.map(input => input.path)).toContain("crates/bunwasm-hermes/cpp/nested.h");
    expect(() => verifyHermesLibrary(root, root, receipt)).not.toThrow();
    expect(readFileSync(receipt, "utf8")).toBe(original);
  });
});

function relocatedHermesFixture(run: (fixture: { original: string; consumer: string; build: string; receipt: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "producer-hermes-consumer-"));
  try {
    const original = join(root, "original"), consumer = join(root, "consumer"), build = join(root, "native");
    const directory = join(original, "crates/bunwasm-hermes/cpp");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(build, "wasi/lib"), { recursive: true });
    const paths = ["shim.cpp", "memory-telemetry.h", "nested.h"].map(name => join(directory, name));
    for (const path of paths) writeFileSync(path, `original input ${path}\n`);
    cpSync(original, consumer, { recursive: true });
    const generated = join(build, "wasi/generated.h");
    paths.push(generated);
    writeFileSync(generated, "generated input\n");
    writeFileSync(join(build, "wasi/lib/libhermesvm_bunwasm.a"), "archive fixture");
    writeFileSync(join(build, "wasi/shim-dependencies.txt"), `shim.cpp.o: #deps 4, deps mtime 1 (VALID)\n${paths.map(path => `    ${path}`).join("\n")}\n\n`);
    const receipt = join(root, "original.json");
    writeFileSync(receipt, JSON.stringify({ sha256: hash("archive fixture"), bytes: 15, ...hermesConsumerReceipt(original, build) }));
    run({ original, consumer, build, receipt });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("unchanged Hermes consumer inputs in a new checkout retain the original compiler identity", () => {
  relocatedHermesFixture(({ original, consumer, build, receipt }) => {
    const recorded = readFileSync(receipt, "utf8");
    writeFileSync(join(consumer, "unrelated-adapter.rs"), "changed engine-only adapter\n");
    expect(() => verifyHermesLibrary(consumer, build, receipt)).not.toThrow();
    expect(readFileSync(receipt, "utf8")).toBe(recorded);
    expect(JSON.parse(recorded).consumerInputs.roots.repository).toBe(original);
    expect(readFileSync(join(build, "wasi/lib/libhermesvm_bunwasm.a"), "utf8")).toBe("archive fixture");
  });
});

test.each(["shim.cpp", "memory-telemetry.h", "nested.h"])("changed current checkout %s rejects unchanged original Hermes inputs", name => {
  relocatedHermesFixture(({ consumer, build, receipt }) => {
    const recorded = readFileSync(receipt, "utf8");
    writeFileSync(join(consumer, "crates/bunwasm-hermes/cpp", name), "changed current consumer input\n");
    expect(() => verifyHermesLibrary(consumer, build, receipt)).toThrow(/new matching native generation/);
    expect(readFileSync(receipt, "utf8")).toBe(recorded);
  });
});

test.each(["missing", "alias"])("a %s current consumer header cannot substitute original compiler bytes", change => {
  relocatedHermesFixture(({ original, consumer, build, receipt }) => {
    const path = "crates/bunwasm-hermes/cpp/memory-telemetry.h";
    unlinkSync(join(consumer, path));
    if (change === "alias") symlinkSync(join(original, path), join(consumer, path));
    expect(() => verifyHermesLibrary(consumer, build, receipt)).toThrow(/new matching native generation/);
  });
});

test.each(["original source", "generated header", "metadata", "receipt root"])("relocated consumer still rejects changed %s", change => {
  relocatedHermesFixture(({ original, consumer, build, receipt }) => {
    if (change === "original source") writeFileSync(join(original, "crates/bunwasm-hermes/cpp/nested.h"), "changed origin\n");
    if (change === "generated header") writeFileSync(join(build, "wasi/generated.h"), "changed generated header\n");
    if (change === "metadata") writeFileSync(join(build, "wasi/shim-dependencies.txt"), "changed dependency metadata\n");
    if (change === "receipt root") {
      const value = JSON.parse(readFileSync(receipt, "utf8"));
      value.consumerInputs.roots.repository = consumer;
      writeFileSync(receipt, JSON.stringify(value));
    }
    expect(() => verifyHermesLibrary(consumer, build, receipt)).toThrow(/new matching native generation/);
  });
});

test("Node admits a new consumer checkout without changing the original Hermes receipt", () => {
  relocatedHermesFixture(({ consumer, build, receipt }) => {
    const recorded = readFileSync(receipt, "utf8");
    const script = `import {verifyHermesLibrary} from ${JSON.stringify(join(import.meta.dir, "consumer-receipt.ts"))}; verifyHermesLibrary(process.argv[1],process.argv[2],process.argv[3]);`;
    const result = Bun.spawnSync(["node", "--input-type=module", "-e", script, consumer, build, receipt]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(receipt, "utf8")).toBe(recorded);
  });
});

test.each(["memory-telemetry.h", "nested.h", "shim.cpp"])("changed %s refuses the original generation with unchanged archive", name => {
  hermesFixture((root, receipt) => {
    const original = readFileSync(receipt, "utf8");
    const archive = readFileSync(join(root, "wasi/lib/libhermesvm_bunwasm.a"));
    writeFileSync(join(root, "crates/bunwasm-hermes/cpp", name), "changed consumer input");
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
    expect(readFileSync(receipt, "utf8")).toBe(original);
    expect(readFileSync(join(root, "wasi/lib/libhermesvm_bunwasm.a"))).toEqual(archive);
  });
});

test.each(["crates/bunwasm-hermes/cpp/memory-telemetry.h", "wasi/shim-dependencies.txt"])("missing %s fails closed", path => {
  hermesFixture((root, receipt) => {
    unlinkSync(join(root, path));
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
  });
});

test.each(["missing", "changed", "bytes", "extra", "path", "root", "metadata", "legacy"])("%s receipt inputs fail closed", change => {
  hermesFixture((root, receipt) => {
    const value = JSON.parse(readFileSync(receipt, "utf8"));
    if (change === "missing") value.consumerInputs.inputs.pop();
    if (change === "changed") value.consumerInputs.inputs[0].sha256 = "0".repeat(64);
    if (change === "bytes") value.consumerInputs.inputs[0].bytes++;
    if (change === "extra") value.consumerInputs.inputs.push(value.consumerInputs.inputs[0]);
    if (change === "path") value.consumerInputs.inputs[0].path = "../outside.h";
    if (change === "root") value.consumerInputs.roots.repository = "/different/repository";
    if (change === "metadata") value.consumerInputs.dependencyMetadata.sha256 = "0".repeat(64);
    if (change === "legacy") delete value.consumerInputs;
    writeFileSync(receipt, JSON.stringify(value));
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
  });
});

test("changed archive bytes and compiler metadata fail closed", () => {
  hermesFixture((root, receipt) => {
    writeFileSync(join(root, "wasi/lib/libhermesvm_bunwasm.a"), "changed archive");
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
    writeFileSync(join(root, "wasi/lib/libhermesvm_bunwasm.a"), "archive fixture");
    const path = join(root, "wasi/shim-dependencies.txt");
    writeFileSync(path, readFileSync(path, "utf8").replace("#deps 4", "#deps 3"));
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
  });
});

test.each(["stale", "omitted shim", "repeated input", "repeated target"])("%s compiler dependency evidence fails closed", change => {
  hermesFixture((root, receipt) => {
    const path = join(root, "wasi/shim-dependencies.txt");
    let text = readFileSync(path, "utf8");
    if (change === "stale") text = text.replace("(VALID)", "(STALE)");
    if (change === "omitted shim") text = text.replace("#deps 4", "#deps 3").replace(`    ${join(root, "crates/bunwasm-hermes/cpp/shim.cpp")}\n`, "");
    if (change === "repeated input") text = text.replace("#deps 4", "#deps 5").trimEnd() + `\n    ${join(root, "crates/bunwasm-hermes/cpp/shim.cpp")}\n\n`;
    if (change === "repeated target") text += text;
    writeFileSync(path, text);
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
  });
});

test("generation binds repository, upstream, generated and external SDK headers under Node", () => {
  const root = mkdtempSync(join(tmpdir(), "producer-hermes-roots-"));
  try {
    const repository = join(root, "repository"), build = join(root, "native"), sdk = join(root, "sdk");
    mkdirSync(join(repository, "crates/bunwasm-hermes/cpp"), { recursive: true });
    mkdirSync(join(build, "wasi/lib"), { recursive: true });
    mkdirSync(join(build, "hermes")); mkdirSync(sdk);
    const overlay = join(build, "wasi/sysroot-include");
    symlinkSync(sdk, overlay, "dir");
    const paths = [join(repository, "crates/bunwasm-hermes/cpp/shim.cpp"), join(repository, "crates/bunwasm-hermes/cpp/memory-telemetry.h"), join(build, "hermes/upstream.h"), join(build, "wasi/generated.h"), join(sdk, "stddef.h")];
    for (const path of paths) writeFileSync(path, "synthetic compiler input\n");
    paths.push(join(overlay, "stddef.h"));
    writeFileSync(join(build, "wasi/lib/libhermesvm_bunwasm.a"), "archive fixture");
    writeFileSync(join(build, "wasi/shim-dependencies.txt"), `shim.cpp.o: #deps 6, deps mtime 1 (VALID)\n${paths.map(path => `    ${path}`).join("\n")}\n\nunused.o: #deps 1, deps mtime 1 (STALE)\n    /unrelated/not/consumed.h\n\n`);
    const original = hermesConsumerReceipt(repository, build);
    expect(original.consumerInputs.inputs.map(input => input.root).sort()).toEqual(["absolute", "build", "build", "build", "repository", "repository"]);
    const receipt = join(root, "original.json");
    writeFileSync(receipt, JSON.stringify({ sha256: hash("archive fixture"), bytes: 15, ...original }));
    const script = `import {hermesConsumerReceipt,verifyHermesLibrary} from ${JSON.stringify(join(import.meta.dir, "consumer-receipt.ts"))}; verifyHermesLibrary(process.argv[1],process.argv[2],process.argv[3]); process.stdout.write(JSON.stringify(hermesConsumerReceipt(process.argv[1],process.argv[2])));`;
    const result = Bun.spawnSync(["node", "--input-type=module", "-e", script, repository, build, receipt]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(original);
    writeFileSync(join(sdk, "stddef.h"), "changed SDK input\n");
    expect(() => verifyHermesLibrary(repository, build, receipt)).toThrow(/new matching native generation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compiler header aliases bind their resolved file and reject retargeting or content drift", () => {
  hermesFixture((root, receipt) => {
    const first = join(root, "sdk-first"), second = join(root, "sdk-second");
    mkdirSync(first); mkdirSync(second);
    for (const directory of [first, second]) writeFileSync(join(directory, "stddef.h"), "same SDK header\n");
    const overlay = join(root, "wasi/sysroot-include");
    symlinkSync(first, overlay, "dir");
    const metadata = join(root, "wasi/shim-dependencies.txt");
    writeFileSync(metadata, readFileSync(metadata, "utf8").replace("#deps 4", "#deps 5").trimEnd() + `\n    ${join(overlay, "stddef.h")}\n\n`);
    const captured = hermesConsumerReceipt(root, root);
    expect(captured.consumerInputs.inputs.find(input => input.path === "wasi/sysroot-include/stddef.h"))
      .toMatchObject({ realPath: join(first, "stddef.h"), sha256: hash("same SDK header\n"), bytes: 16 });
    writeFileSync(receipt, JSON.stringify({ sha256: hash("archive fixture"), bytes: 15, ...captured }));
    const original = readFileSync(receipt, "utf8");
    expect(() => verifyHermesLibrary(root, root, receipt)).not.toThrow();
    unlinkSync(overlay); symlinkSync(second, overlay, "dir");
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
    unlinkSync(overlay); symlinkSync(first, overlay, "dir");
    writeFileSync(join(first, "stddef.h"), "changed SDK header\n");
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
    unlinkSync(join(first, "stddef.h"));
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
    expect(readFileSync(receipt, "utf8")).toBe(original);
    expect(readFileSync(join(root, "wasi/lib/libhermesvm_bunwasm.a"), "utf8")).toBe("archive fixture");
  });
});

