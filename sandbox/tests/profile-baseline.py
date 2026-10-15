#!/usr/bin/env python3
"""Add timestamped guest markers to a disposable baseline site build, without changing its engines."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=Path)
args = parser.parse_args()
worker = args.root / "worker.js"
source = worker.read_text()
marker = 'self.postMessage({type:"stdout",data:new TextEncoder().encode("[profile] worker-ready "+Date.now()+"\\n")});\n'
if "[profile] worker-ready" not in source:
    worker.write_text(marker + source)
template = args.root / "template.json"
data = json.loads(template.read_text())
dev = data["files"]["dev.ts"]
if "[profile] dev-start" not in dev:
    if "const root = import.meta.dir;" not in dev or "await bundleDeps();" not in dev:
        raise SystemExit("Baseline dev.ts does not match the expected startup points")
    dev = dev.replace("const root = import.meta.dir;", 'console.log("[profile] dev-start " + Date.now());\nconst root = import.meta.dir;', 1)
    dev = dev.replace("await bundleDeps();", 'console.log("[profile] deps-start " + Date.now());\nawait bundleDeps();', 1)
    data["files"]["dev.ts"] = dev
    template.write_text(json.dumps(data, separators=(",", ":")))
