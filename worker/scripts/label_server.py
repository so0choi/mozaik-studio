#!/usr/bin/env python3
"""Local-only labeling server (dev tool, not part of the product).

Usage: python3 worker/scripts/label_server.py SHEET_DIR [--port 8765]
"""
import argparse
import datetime
import json
import mimetypes
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "label_app", "index.html")
MAX_BODY = 1024 * 1024
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
}

SHEET_DIR = ""
LABELS_PATH = ""
ITEM_IDS = set()
LOCK = threading.Lock()


def read_labels():
    try:
        with open(LABELS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def write_labels(labels):
    fd, tmp = tempfile.mkstemp(dir=SHEET_DIR, prefix=".labels-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(labels, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, LABELS_PATH)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class Handler(BaseHTTPRequestHandler):
    server_version = "LabelServer/1"

    def _send(self, code, body, ctype, nocache=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if nocache:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, body, TYPES[".json"], nocache=True)

    def _file(self, path):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self._send(404, b"not found", "text/plain")
        ext = os.path.splitext(path)[1].lower()
        ctype = TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
        self._send(200, body, ctype)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            return self._file(INDEX)
        if path == "/api/labels":
            with LOCK:
                return self._json(200, read_labels())
        if path.startswith("/sheet/"):
            rel = unquote(path[len("/sheet/"):])
            if "\x00" in rel:
                return self._send(400, b"bad path", "text/plain")
            full = os.path.realpath(os.path.join(SHEET_DIR, rel))
            root = os.path.realpath(SHEET_DIR)
            if not (full == root or full.startswith(root + os.sep)) or not os.path.isfile(full):
                return self._send(404, b"not found", "text/plain")
            return self._file(full)
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if urlsplit(self.path).path != "/api/labels":
            return self._send(404, b"not found", "text/plain")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json(400, {"error": "bad length"})
        if length > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return self._json(400, {"error": "bad json"})
        if not isinstance(data, dict):
            return self._json(400, {"error": "bad body"})
        item_id = data.get("id")
        answer = data.get("answer")
        if not isinstance(item_id, str) or item_id not in ITEM_IDS:
            return self._json(400, {"error": "unknown id"})
        if answer is not None and not isinstance(answer, dict):
            return self._json(400, {"error": "answer must be object or null"})
        with LOCK:
            labels = read_labels()
            if answer is None:
                labels.pop(item_id, None)
            else:
                answer["updatedAt"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
                labels[item_id] = answer
            write_labels(labels)
            return self._json(200, labels)

    def log_message(self, fmt, *args):
        pass


def main():
    global SHEET_DIR, LABELS_PATH, ITEM_IDS
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet_dir")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    SHEET_DIR = os.path.abspath(args.sheet_dir)
    LABELS_PATH = os.path.join(SHEET_DIR, "labels.json")
    with open(os.path.join(SHEET_DIR, "items.json"), encoding="utf-8") as f:
        items = json.load(f)
    ITEM_IDS = {it["id"] for it in items.get("items", [])}
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"http://127.0.0.1:{args.port}/  ({len(ITEM_IDS)} items)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
