#!/usr/bin/env python3
"""Helpers for porting vendored Bun sources to wasm32-wasi.

  stub(path, needle, body)   gate the fn whose signature line contains `needle`
                             with cfg(not(wasi)) and add a cfg(wasi) twin whose
                             body is `body` (signature copied verbatim)
  add_wasi(path, needle)     add `target_os = "wasi"` to the cfg attribute on
                             the line containing `needle` (or just above it)
  sub(path, old, new)        exact replace, must match
"""
import re
import sys

WASI = 'target_os = "wasi"'


def _read(path):
    with open(path) as f:
        return f.read()


def _write(path, s):
    with open(path, "w") as f:
        f.write(s)


def sub(path, old, new, count=1):
    s = _read(path)
    if old not in s:
        raise SystemExit(f"{path}: not found: {old[:80]!r}")
    _write(path, s.replace(old, new, count))


def _fn_span(s, needle):
    i = s.find(needle)
    if i < 0:
        raise SystemExit(f"not found: {needle!r}")
    start = s.rfind("\n", 0, i) + 1
    # include attributes / doc comments directly above
    while True:
        prev_end = start - 1
        prev_start = s.rfind("\n", 0, prev_end) + 1
        line = s[prev_start:prev_end].strip()
        if line.startswith("#[") or line.startswith("///"):
            start = prev_start
        else:
            break
    brace = s.find("{", i)
    depth = 0
    j = brace
    while True:
        c = s[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    return start, s.rfind("\n", 0, i) + 1, brace, j + 1


def stub(path, needle, body):
    s = _read(path)
    start, sig_start, brace, end = _fn_span(s, needle)
    indent = re.match(r"\s*", s[sig_start:]).group(0)
    attrs = s[start:sig_start]
    # keep non-cfg attributes (inline, must_use...) on the twin
    keep = "".join(l + "\n" for l in attrs.splitlines() if "cfg" not in l and not l.strip().startswith("///"))
    sig = s[sig_start:brace].rstrip()
    original = s[start:end]
    twin = f"{keep}{indent}#[cfg({WASI})]\n{sig} {{\n"
    for line in body.strip("\n").splitlines():
        twin += f"{indent}    {line}\n" if line else "\n"
    twin += f"{indent}}}"
    gated = original.replace(sig_start - start and s[sig_start:brace] or s[sig_start:brace], f"{indent}#[cfg(not({WASI}))]\n" + s[sig_start:brace].lstrip("\n"), 1) if False else None
    # put cfg(not(wasi)) right above the signature
    gated = s[start:sig_start] + f"{indent}#[cfg(not({WASI}))]\n" + s[sig_start:end]
    _write(path, s[:start] + gated + "\n" + twin + s[end:])


def add_wasi(path, needle, nth=1):
    s = _read(path)
    lines = s.split("\n")
    hits = [k for k, l in enumerate(lines) if needle in l]
    if len(hits) < nth:
        raise SystemExit(f"{path}: not found: {needle!r}")
    k = hits[nth - 1]
    for k2 in (k, k - 1, k - 2):
        l = lines[k2]
        m = re.search(r"#\[cfg\((.*)\)\]\s*$", l)
        if m:
            pred = m.group(1)
            if pred.startswith("any("):
                new = f"any({pred[4:-1]}, {WASI})"
            else:
                new = f"any({pred}, {WASI})"
            lines[k2] = l[: m.start(1)] + new + l[m.end(1):]
            _write(path, "\n".join(lines))
            return
    raise SystemExit(f"{path}: no cfg near {needle!r}")


if __name__ == "__main__":
    print(__doc__)
    sys.exit(0)
