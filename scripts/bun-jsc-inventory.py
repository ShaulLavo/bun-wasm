#!/usr/bin/env python3
"""Count lexical bun_jsc references. This does not resolve Rust types or trait methods."""

import argparse
import collections
import hashlib
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parent.parent
USE = re.compile(r"\buse\s+(?:bun_jsc|crate::jsc|jsc)::([^;]+);", re.S)
QUALIFIED = re.compile(r"\b(?:bun_jsc|jsc)::([A-Za-z_][A-Za-z_0-9]*)")
TRIVIA = re.compile(r'//[^\n]*|/\*.*?\*/|r(\#*)".*?"\1|"(?:\\.|[^"\\])*"', re.S)


def split_tree(text):
    depth = 0
    start = 0
    parts = []
    for index, char in enumerate(text):
        depth += (char == "{") - (char == "}")
        if char == "," and depth == 0:
            parts.append(text[start:index].strip())
            start = index + 1
    return [part for part in parts + [text[start:].strip()] if part]


def bindings(tree, prefix=""):
    result = []
    for item in split_tree(tree):
        if "{" in item:
            head, tail = item.split("{", 1)
            result.extend(bindings(tail.rsplit("}", 1)[0], prefix + head))
            continue
        path, *alias = re.split(r"\s+as\s+", prefix + item)
        if path.endswith("::self"):
            path = path[:-6]
        result.append((path, alias[0] if alias else path.rsplit("::", 1)[-1]))
    return result


def file_counts(path):
    source = TRIVIA.sub(" ", path.read_text())
    imports = [binding for match in USE.finditer(source) for binding in bindings(match[1])]
    body = USE.sub(" ", source)
    references = collections.Counter(QUALIFIED.findall(body))
    imported = collections.Counter()
    wildcard = 0
    for symbol, alias in imports:
        if alias == "*":
            wildcard += 1
            continue
        imported[symbol] += 1
        if alias not in ("_", "self", "jsc", "bun_jsc"):
            references[symbol] += len(re.findall(r"\b" + re.escape(alias) + r"\b", body))
    return imported, references, wildcard


def census(vendor, relative):
    paths = sorted((vendor / relative).rglob("*.rs"))
    imports = collections.Counter()
    references = collections.Counter()
    users = 0
    wildcard = 0
    for path in paths:
        file_imports, file_references, stars = file_counts(path)
        imports.update(file_imports)
        references.update(file_references)
        users += bool(file_imports or file_references or stars)
        wildcard += stars
    symbols = sorted(set(imports) | set(references), key=lambda name: (-references[name], name))
    return {
        "scope": relative,
        "rust_files": len(paths),
        "files_using_bun_jsc": users,
        "import_bindings": imports.total(),
        "references": references.total(),
        "wildcard_imports": wildcard,
        "symbols": [
            {"api": symbol, "imports": imports[symbol], "references": references[symbol]}
            for symbol in symbols
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vendor", type=Path, default=ROOT / "vendor/bun")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", type=Path, help="check source counts and selected module bytes, ignoring commit metadata")
    options = parser.parse_args()
    manifests = sorted((options.vendor / "src").glob("*/Cargo.toml"))
    scopes = ["src/runtime"] + [
        str(manifest.parent.relative_to(options.vendor))
        for manifest in manifests
        if manifest.parent.name not in ("runtime", "jsc")
        and re.search(r"^bun_jsc\s*[.=]", manifest.read_text(), re.M)
    ]
    result = {
        "bun_revision": subprocess.check_output(
            ["git", "-C", str(options.vendor), "rev-parse", "HEAD"], text=True
        ).strip(),
        "semver_source_sha256": hashlib.sha256(
            (options.vendor / "src/semver_jsc/SemverObject.rs").read_bytes()
        ).hexdigest(),
        "method": "Lexical imports and identifier references outside use declarations; comments and strings excluded. Not method resolution; aliases may be shadowed. Wildcard and extension-trait calls are not attributable.",
        "scopes": [census(options.vendor, scope) for scope in scopes],
    }
    if options.check:
        expected = json.loads(options.check.read_text())
        keys = ("semver_source_sha256", "scopes")
        if any(result[key] != expected[key] for key in keys):
            raise SystemExit("bun_jsc source inventory changed; regenerate the inventory and review the backend coverage")
        print("bun_jsc source inventory matches")
        return
    output = json.dumps(result, indent=2) + "\n"
    if options.output:
        options.output.write_text(output)
        return
    print(output, end="")


if __name__ == "__main__":
    main()
