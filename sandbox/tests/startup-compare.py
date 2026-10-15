#!/usr/bin/env python3
"""Summarize startup-profile JSON: startup-compare.py BEFORE AFTER OUTPUT.json."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()


def event(data, name):
    return next((item for item in data["events"] if item["name"] == name), None)


def measure(data, name):
    return next((item["duration"] for item in data["phases"] if item["name"] == f"bunwasm:{name}" and item["entryType"] == "measure"), None)


def summary(path, stage):
    data = json.loads(path.read_text())
    wasm = next((item for item in data["resources"] if ".wasm" in item["name"]), None)
    template = next((item for item in data["resources"] if "template.json" in item["name"]), None)
    decompress = event(data, "decompression-pipeline")
    compile_event = event(data, "wasm-compile") or event(data, "wasm-compileStreaming")
    created = event(data, "worker-created")
    ready = event(data, "worker-ready")
    dev = event(data, "dev-start")
    listening = event(data, "dev-server-listening")
    deps = event(data, "bundle-deps")
    navigation = next(iter(data["frameNavigation"]), None)
    scripts = [item for item in data["frameResources"] if item["initiatorType"] == "script"]
    module_starts = [item["topStartTime"] for item in scripts]
    module_ends = [item["topStartTime"] + item["duration"] for item in scripts]
    return {
        "engine": data["engine"], "visit": "reload" if "reload" in data["run"] else "cold", "stage": stage,
        "wasmNetwork": wasm["duration"] if wasm else 0, "wasmTransferred": wasm["transferSize"] if wasm else 0,
        "templateNetwork": template["duration"] if template else None, "templateTransferred": template["transferSize"] if template else None,
        "templateLoad": measure(data, "template"),
        "inflateAndCompile": compile_event["startTime"] + compile_event["duration"] - decompress["startTime"] if stage == "before" else measure(data, "compile"),
        "decompressionPipeline": decompress["duration"] if stage == "before" else measure(data, "decompress") or 0,
        "compileWall": compile_event["duration"],
        "workerBootstrap": ready["startTime"] - created["startTime"] if ready else measure(data, "worker-start"),
        "workerToDevStart": dev["startTime"] - created["startTime"] if dev else measure(data, "dev-start"),
        "devInit": event(data, "deps-start")["startTime"] - dev["startTime"] if stage == "before" and dev else measure(data, "bundling-react"),
        "depsBuildOrRestore": deps["duration"] if stage == "before" else measure(data, "bundled-react") or measure(data, "deps-cached"),
        "serverToRender": data["navToRender"] - listening["startTime"],
        "firstPreviewDocument": navigation["responseEnd"] if navigation else None,
        "previewModuleRequests": max(module_ends) - min(module_starts) if module_ends else None,
        "lastModuleResponseToPaint": data["navToRender"] - max(module_ends) if module_ends else None,
        "navToRender": data["navToRender"],
        "engineCacheHit": any(item["name"] == "bunwasm:engine-cache-hit" for item in data["phases"]),
        "depsCached": any(item["name"] == "bunwasm:deps-cached" for item in data["phases"]),
    }


rows = [summary(path, stage) for stage, directory in [("before", args.before), ("after", args.after)] for path in sorted(directory.glob("*.json"))]
result = {"rows": rows, "notes": [
    "All durations are milliseconds. Phases overlap; do not sum them.",
    "Before uses serial decompression then compilation; after uses overlapping streaming compilation. Warm after compiles cached uncompressed bytes.",
    "CDP 6x slows the page and React, but dedicated worker CPU is unchanged.",
    "Last module response to paint includes pending React execution, sampling and two animation frames.",
]}
args.output.write_text(json.dumps(result, indent=2) + "\n")
for row in rows:
    print(f'{row["engine"]:7} {row["visit"]:6} {row["stage"]:6} {row["navToRender"]:7.0f} ms; engine cache={row["engineCacheHit"]}, deps cache={row["depsCached"]}')
