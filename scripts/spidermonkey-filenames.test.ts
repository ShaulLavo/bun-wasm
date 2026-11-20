import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("SpiderMonkey diagnostic filenames and host replies preserve virtual IDs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-filenames-"));
  try {
    const boundary = join(scratch, "filename");
    execFileSync("c++", ["-std=c++20", "-Wall", "-Wextra", "-Werror", "-o", boundary,
      resolve("crates/bunwasm-spidermonkey/tests/filename.cpp")]);
    execFileSync(boundary, [], { stdio: "inherit" });
    const replies = join(scratch, "reply-buffer");
    execFileSync("rustc", ["--edition=2024", "--test", "-o", replies,
      resolve("crates/bunwasm-engine-spidermonkey/src/reply_buffer.rs")]);
    execFileSync(replies, [], { stdio: "inherit" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

// The SavedFrame reader decodes every Filename-kind label, so each compiler filename the
// adapter gives SpiderMonkey must come from DiagnosticFilename or be a plain literal.
// This is a closed inventory of today's production sources, not a proof of arbitrary C++
// data flow: a new compile site, setter or helper fails here until it is reviewed.
const adapterRoot = "crates/bunwasm-spidermonkey/cpp";
const compileEntries: Record<string, Record<string, number>> = {
  "engine.cpp": { "JS::CompileModule": 1, "JS::Compile": 2 },
  "shim.cpp": { "JS::Evaluate": 1 },
};
const compileEntry = /\b(?:JS::)?(?:Compile\w*|Evaluate\w*|Instantiate\w*|\w*Stencil\w*)\s*\(|\bJS_(?:Compile|Evaluate)\w*\s*\(/g;
const forbidden = [/\.setFile\s*\(/, /Introduc/, /OwningCompileOptions/, /ReadOnlyCompileOptions/, /CompileOptions\s*&/];
const literalLabel = /^"[A-Za-z0-9._/-]+"$/;

function adapterSources(): Record<string, string> {
  return Object.fromEntries(readdirSync(adapterRoot).map(name => [name, readFileSync(join(adapterRoot, name), "utf8")]));
}

function entryFindings(name: string, text: string): string[] {
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(compileEntry)) {
    const entry = match[0].replace(/\s*\($/, "");
    counts[entry] = (counts[entry] ?? 0) + 1;
  }
  const expected = compileEntries[name] ?? {};
  const findings = forbidden.filter(pattern => pattern.test(text)).map(pattern => `${name}: forbidden ${pattern}`);
  for (const entry of new Set(Object.keys(counts).concat(Object.keys(expected)))) {
    if (counts[entry] !== expected[entry]) findings.push(`${name}: ${entry} appears ${counts[entry] ?? 0} times, inventory ${expected[entry] ?? 0}`);
  }
  return findings;
}

// The receiver must be declared as a DiagnosticFilename between the options and the setter.
function labelFinding(name: string, segment: string, label: string): string | undefined {
  if (literalLabel.test(label)) return undefined;
  const receiver = /^(\w+)\.c_str\(\)$/.exec(label)?.[1];
  if (!receiver) return `${name}: unrecognized filename argument ${label}`;
  const declarations = Array.from(segment.matchAll(new RegExp(`([\\w:]+(?:\\s*[*&])?)\\s+${receiver}\\s*[({=]`, "g")), match => match[1]);
  if (declarations.length === 1 && declarations[0] === "bunsm::DiagnosticFilename") return undefined;
  return `${name}: ${receiver} is not a DiagnosticFilename declared for this compile (${declarations.join(", ") || "undeclared"})`;
}

function optionsFindings(name: string, text: string): string[] {
  const findings: string[] = [];
  for (const declaration of text.matchAll(/\bCompileOptions\s+(\w+)\s*\(/g)) {
    const start = declaration.index ?? 0;
    const setter = new RegExp(`\\b${declaration[1]}\\.setFileAndLine\\(\\s*(.*?)\\s*,`).exec(text.slice(start));
    if (!setter) {
      findings.push(`${name}: CompileOptions ${declaration[1]} has no setFileAndLine`);
      continue;
    }
    const finding = labelFinding(name, text.slice(start, start + setter.index), setter[1] ?? "");
    if (finding) findings.push(finding);
  }
  const declared = Array.from(text.matchAll(/\bCompileOptions\s+\w+\s*\(/g)).length;
  const setters = Array.from(text.matchAll(/\.setFileAndLine\(/g)).length;
  if (declared !== setters) findings.push(`${name}: ${setters} filename setters for ${declared} CompileOptions`);
  return findings;
}

function filenameInventoryFindings(sources: Record<string, string>): string[] {
  const findings = Object.entries(sources).flatMap(([name, text]) => entryFindings(name, text).concat(optionsFindings(name, text)));
  const owners = Object.entries(sources).filter(([, text]) => /class\s+DiagnosticFilename\b/.test(text)).map(([name]) => name);
  if (owners.join() !== "filename.h") findings.push(`DiagnosticFilename must be defined only in filename.h, found in ${owners.join(", ") || "none"}`);
  for (const name of Object.keys(compileEntries)) {
    if (!(name in sources)) findings.push(`${name}: inventoried compile file is missing`);
  }
  return findings;
}

test("every adapter compiler filename is encoded or a plain literal", () => {
  expect(filenameInventoryFindings(adapterSources())).toEqual([]);
});

test("the compiler filename inventory rejects bypasses", () => {
  const sources = adapterSources();
  const engine = sources["engine.cpp"] ?? "";
  const ordinary = "options.setFileAndLine(label.c_str(), static_cast<uint32_t>(line));";
  expect(engine).toContain(ordinary);
  const bypasses: Record<string, Record<string, string>> = {
    "setFile": { "engine.cpp": engine.replace(ordinary, `options.setFile(label.c_str()); ${ordinary}`) },
    "std::string receiver": { "engine.cpp": engine.replace(ordinary, `std::string raw(filename); options.setFileAndLine(raw.c_str(), 1);`) },
    "escaped percent literal": { "engine.cpp": engine.replace(ordinary, `options.setFileAndLine("bad\\x25name", 1);`) },
    "percent literal": { "engine.cpp": engine.replace(ordinary, `options.setFileAndLine("bad%00name", 1);`) },
    "NUL escape literal": { "engine.cpp": engine.replace(ordinary, `options.setFileAndLine("bad\\0name", 1);`) },
    "concatenated literal": { "engine.cpp": engine.replace(ordinary, `options.setFileAndLine("a" "b", 1);`) },
    "macro label": { "engine.cpp": engine.replace(ordinary, `options.setFileAndLine(BUNSM_LABEL, 1);`) },
    "custom introduction": { "engine.cpp": engine.replace(ordinary, `${ordinary} options.setIntroductionType("x%00");`) },
    "new compile entry": { "engine.cpp": `${engine}\nvoid extra() { JS::CompileFunction(context, envChain, options, "f", 0, nullptr, text); }\n` },
    "temporary options": { "engine.cpp": `${engine}\nvoid extra() { JS::Compile(context, JS::CompileOptions(context), text); }\n` },
    "header helper": { "filename.h": `${sources["filename.h"] ?? ""}\ninline void compile_label(JS::CompileOptions options(context)) { options.setFileAndLine("x", 1); JS::Compile(context, options, text); }\n` },
    "second DiagnosticFilename": { "engine.h": `${sources["engine.h"] ?? ""}\nclass DiagnosticFilename {};\n` },
  };
  for (const [label, change] of Object.entries(bypasses)) {
    const findings = filenameInventoryFindings({ ...sources, ...change });
    expect({ label, rejected: findings.length > 0 }).toEqual({ label, rejected: true });
  }
});
