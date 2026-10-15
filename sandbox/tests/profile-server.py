#!/usr/bin/env python3
"""Serve a site with COOP/COEP and first-navigation startup measurements.

python3 profile-server.py --root site/dist --results /work/tmp/bun-wasm-profile --port 4181
Open /?profile=unique-run&engine=browser. A fresh port gives Safari a fresh origin.
Copy this script and startup-probe.js together when running on the Mac.
"""

import argparse
import gzip
import json
import mimetypes
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", required=True, type=Path)
parser.add_argument("--results", required=True, type=Path)
parser.add_argument("--port", type=int, default=4181)
parser.add_argument("--activation-delay-ms", type=int, default=0)
args = parser.parse_args()
args.root = args.root.resolve()
args.results.mkdir(parents=True, exist_ok=True)
probe = Path(__file__).with_name("startup-probe.js").read_bytes()
write_lock = threading.Lock()
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *handler_args, **kwargs):
        super().__init__(*handler_args, directory=str(args.root), **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format_string, *values):
        entry = {"time": time.time(), "request": self.path, "message": format_string % values}
        with write_lock:
            with (args.results / "requests.jsonl").open("a") as log:
                log.write(json.dumps(entry) + "\n")

    def send_bytes(self, data, content_type, encoding=None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        request_path = urlsplit(self.path).path
        if request_path == "/__profile/probe.js":
            return self.send_bytes(probe, "text/javascript")
        if request_path == "/__profile/results":
            data = json.dumps([json.loads(path.read_text()) for path in sorted(args.results.glob("*.json"))]).encode()
            return self.send_bytes(data, "application/json")
        path = Path(self.translate_path(request_path))
        if path.is_dir():
            path /= "index.html"
        if path.name == "index.html" and path.is_file():
            html = path.read_bytes().replace(b"<head>", b'<head><script src="/__profile/probe.js"></script>', 1)
            return self.send_bytes(html, "text/html;charset=utf-8")
        if path.name == "sw.js" and path.is_file() and args.activation_delay_ms:
            delay = f'self.addEventListener("activate", event => event.waitUntil(new Promise(resolve => setTimeout(resolve, {args.activation_delay_ms}))));\n'
            return self.send_bytes(delay.encode() + path.read_bytes(), "text/javascript")
        if path.suffix == ".wasm" and path.with_suffix(".wasm.gz").is_file():
            data = path.with_suffix(".wasm.gz").read_bytes()
            if "gzip" in self.headers.get("Accept-Encoding", ""):
                return self.send_bytes(data, "application/wasm", "gzip")
            return self.send_bytes(gzip.decompress(data), "application/wasm")
        return super().do_GET()

    def do_POST(self):
        request = urlsplit(self.path)
        if request.path != "/__profile":
            return self.send_error(404)
        run = parse_qs(request.query).get("run", [""])[0]
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,150}", run):
            return self.send_error(400, "Invalid profile run name")
        size = int(self.headers.get("Content-Length", "0"))
        if size > 2_000_000:
            return self.send_error(413)
        data = json.loads(self.rfile.read(size))
        with write_lock:
            temporary = args.results / f"{run}.pending"
            temporary.write_text(json.dumps(data, indent=2) + "\n")
            temporary.replace(args.results / f"{run}.json")
        self.send_bytes(b"{}", "application/json")


server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}/", "root": str(args.root), "results": str(args.results.resolve())}), flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
