#!/usr/bin/env python3
"""Tiny LAN-only vision service for Groovekeeper.

Run with: python3 vision_service.py
First request downloads the selected MLX model into the local Hugging Face cache.
"""
import base64
import csv
import io
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

HOST = os.environ.get("GROOVEKEEPER_VISION_HOST", "0.0.0.0")
PORT = int(os.environ.get("GROOVEKEEPER_VISION_PORT", "8765"))
MODEL_ID = os.environ.get("GROOVEKEEPER_VISION_MODEL", "mlx-community/Qwen2-VL-2B-Instruct-4bit")
VISION_PROVIDER = os.environ.get("GROOVEKEEPER_VISION_PROVIDER", "mlx").strip().lower()
OLLAMA_URL = os.environ.get("GROOVEKEEPER_OLLAMA_URL", "http://ollama:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("GROOVEKEEPER_OLLAMA_MODEL", "qwen2.5vl:3b")
MODEL = None
PROCESSOR = None
CONFIG = None
MODEL_LOCK = threading.Lock()
DISCOGS_TOKEN = os.environ.get("GROOVEKEEPER_DISCOGS_TOKEN", "").strip()
DISCOGS_USER_AGENT = os.environ.get("GROOVEKEEPER_USER_AGENT", "Groovekeeper/0.1 +local-vinyl-catalogue")
DATABASE_PATH = os.environ.get("GROOVEKEEPER_DATABASE", os.path.join(os.path.dirname(__file__), "groovekeeper.sqlite3"))

PROMPT = """Look carefully at this photograph of a vinyl record shelf. Read every record spine whose text is genuinely visible. Return ONLY valid JSON in this exact shape:
[{"artist":"...","title":"...","confidence":0.0,"evidence":"short visible text"}]
Use an empty string for unknown artist or title. Do not guess or invent records. Keep confidence between 0 and 1. Include only records with at least some visible title or artist text."""


def database_connection():
    connection = sqlite3.connect(DATABASE_PATH, timeout=20)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database():
    with database_connection() as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)")
        connection.execute("CREATE TABLE IF NOT EXISTS scan_sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")


def collection_records():
    with database_connection() as connection:
        return [json.loads(row["data"]) for row in connection.execute("SELECT data FROM records ORDER BY updated_at DESC")]


def sync_collection(records):
    now = int(time.time() * 1000)
    clean = [record for record in records if isinstance(record, dict) and record.get("id")]
    with database_connection() as connection:
        connection.execute("DELETE FROM records")
        connection.executemany(
            "INSERT INTO records (id, data, updated_at) VALUES (?, ?, ?)",
            [(str(record["id"]), json.dumps(record, separators=(",", ":")), now) for record in clean],
        )
    return clean


def save_scan_session(payload):
    session_id = str(payload.get("id") or uuid.uuid4())
    now = int(time.time() * 1000)
    payload = {**payload, "id": session_id, "updatedAt": now}
    with database_connection() as connection:
        existing = connection.execute("SELECT created_at FROM scan_sessions WHERE id = ?", (session_id,)).fetchone()
        created_at = existing["created_at"] if existing else now
        connection.execute(
            "INSERT OR REPLACE INTO scan_sessions (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (session_id, str(payload.get("status") or "prepared"), json.dumps(payload, separators=(",", ":")), created_at, now),
        )
    return payload


def scan_sessions(limit=12):
    with database_connection() as connection:
        return [json.loads(row["data"]) for row in connection.execute("SELECT data FROM scan_sessions ORDER BY updated_at DESC LIMIT ?", (limit,))]


def parse_discogs_csv(text):
    records = []
    for index, row in enumerate(csv.DictReader(io.StringIO(text))):
        artist = (row.get("Artist") or row.get("artist") or "").strip()
        title = (row.get("Title") or row.get("title") or "").strip()
        if not artist and not title:
            continue
        release_id = (row.get("release_id") or row.get("Release ID") or row.get("releaseId") or "").strip()
        records.append({
            "id": str(uuid.uuid4()), "artist": artist, "title": title,
            "year": (row.get("Released") or row.get("Year") or "—").strip() or "—",
            "condition": (row.get("Media Condition") or row.get("Condition") or "Not graded").strip() or "Not graded",
            "meta": "Vinyl · imported from Discogs", "value": None,
            "recent": int(time.time() * 1000) + index, "cover": f"cover-{index % 6 + 1}",
            "flag": False, "artworkStatus": "", "discogsReleaseId": release_id or None,
            "label": (row.get("Label") or "").strip(), "catno": (row.get("Catalog#") or row.get("Catalog Number") or "").strip(),
        })
    return records


def model_ready():
    global MODEL, PROCESSOR, CONFIG
    if MODEL is not None:
        return
    with MODEL_LOCK:
        if MODEL is not None:
            return
        from mlx_vlm import load
        from mlx_vlm.utils import load_config
        MODEL, PROCESSOR = load(MODEL_ID)
        CONFIG = load_config(MODEL_ID)


def decode_image(data_url):
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url)


def extract_json(text):
    match = re.search(r"\[[\s\S]*\]", text or "")
    values = []
    if match:
        try:
            parsed = json.loads(match.group(0))
            values = parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            pass
    if not values:
        for candidate in re.findall(r"\{[^{}]*\}", text or ""):
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    values.append(parsed)
            except json.JSONDecodeError:
                continue
    unique = []
    seen = set()
    for item in values:
        artist = str(item.get("artist", "")).strip()
        title = str(item.get("title", "")).strip()
        key = (artist.casefold(), title.casefold())
        if not any(key) or key in seen:
            continue
        seen.add(key)
        confidence = item.get("confidence", 0)
        try:
            confidence = float(confidence)
            if confidence > 1:
                confidence /= 100
        except (TypeError, ValueError):
            confidence = 0
        unique.append({
            "artist": artist,
            "title": title,
            "confidence": max(0, min(1, confidence)),
            "evidence": item.get("evidence", ""),
        })
    return unique[:40]


def analyze(data_url, prompt=PROMPT):
    if VISION_PROVIDER == "ollama":
        return analyze_with_ollama(data_url, prompt)

    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template

    raw = decode_image(data_url)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
            handle.write(raw)
            temp_path = handle.name
        model_ready()
        formatted = apply_chat_template(PROCESSOR, CONFIG, prompt, num_images=1)
        # Each request is one small shelf panel with at most eight records.
        # Keeping the response bounded makes the nine-panel scan materially
        # faster and avoids the long, truncated lists produced by full photos.
        output = generate(MODEL, PROCESSOR, formatted, [temp_path], max_tokens=384, temp=0.0, verbose=False)
        output_text = getattr(output, "text", None) or str(output)
        return {"records": extract_json(output_text), "raw": output_text}
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


def analyze_with_ollama(data_url, prompt=PROMPT):
    image_data = data_url.split(",", 1)[1] if "," in data_url else data_url
    body = json.dumps({
        "model": OLLAMA_MODEL,
        "stream": False,
        "messages": [{"role": "user", "content": prompt, "images": [image_data]}],
        "options": {"temperature": 0, "num_predict": 384},
    }).encode()
    request = Request(
        f"{OLLAMA_URL}/api/chat",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=300) as response:
            payload = json.loads(response.read())
    except HTTPError as error:
        raise RuntimeError(f"Ollama returned {error.code}: {error.read().decode(errors='replace')}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach Ollama at {OLLAMA_URL}: {error.reason}") from error
    output_text = str((payload.get("message") or {}).get("content") or "")
    return {"records": extract_json(output_text), "raw": output_text}


def discogs_request(path, params=None):
    if not DISCOGS_TOKEN:
        raise RuntimeError("Discogs token is not configured")
    query = f"?{urlencode(params)}" if params else ""
    request = Request(
        f"https://api.discogs.com{path}{query}",
        headers={
            "Authorization": f"Discogs token={DISCOGS_TOKEN}",
            "User-Agent": DISCOGS_USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except HTTPError as error:
        try:
            detail = json.loads(error.read()).get("message", str(error))
        except (json.JSONDecodeError, AttributeError):
            detail = str(error)
        raise RuntimeError(f"Discogs returned {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach Discogs: {error.reason}") from error


def search_discogs(artist="", title="", barcode=""):
    search_params = {
        "type": "release",
        "format": "Vinyl",
        "per_page": 12,
    }
    if barcode:
        search_params["barcode"] = re.sub(r"\D", "", barcode)
    else:
        search_params["artist"] = artist
        search_params["release_title"] = title
    payload = discogs_request("/database/search", search_params)
    releases = []
    for item in payload.get("results", []):
        release_id = item.get("id")
        if not release_id:
            continue
        releases.append({
            "id": release_id,
            "title": item.get("title", ""),
            "year": item.get("year"),
            "country": item.get("country", ""),
            "label": (item.get("label") or [""])[0],
            "catno": item.get("catno", ""),
            "format": item.get("format", []),
            "genre": item.get("genre", []),
            "style": item.get("style", []),
            "coverUrl": item.get("cover_image") or item.get("thumb", ""),
            "discogsUrl": f"https://www.discogs.com/release/{release_id}",
        })
    return releases


def discogs_prices(release_id):
    payload = discogs_request(f"/marketplace/price_suggestions/{int(release_id)}")
    return {
        condition: {"value": price.get("value"), "currency": price.get("currency", "")}
        for condition, price in payload.items()
        if isinstance(price, dict) and price.get("value") is not None
    }


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/collection":
            self.send_json(200, {"records": collection_records()})
            return
        if parsed.path == "/scan-sessions":
            self.send_json(200, {"sessions": scan_sessions()})
            return
        if parsed.path == "/discogs/search":
            if not DISCOGS_TOKEN:
                self.send_json(503, {"error": "Discogs token is not configured", "setupRequired": True})
                return
            params = parse_qs(parsed.query)
            artist = (params.get("artist") or [""])[0].strip()
            title = (params.get("title") or [""])[0].strip()
            barcode = re.sub(r"\D", "", (params.get("barcode") or [""])[0])
            if not artist and not title and not barcode:
                self.send_json(400, {"error": "Artist, title or barcode is required"})
                return
            try:
                self.send_json(200, {"releases": search_discogs(artist, title, barcode)})
            except Exception as error:
                self.send_json(502, {"error": str(error)})
            return
        price_match = re.fullmatch(r"/discogs/price/(\d+)", parsed.path)
        if price_match:
            if not DISCOGS_TOKEN:
                self.send_json(503, {"error": "Discogs token is not configured", "setupRequired": True})
                return
            try:
                self.send_json(200, {"prices": discogs_prices(price_match.group(1))})
            except Exception as error:
                self.send_json(502, {"error": str(error)})
            return
        if parsed.path in ("/", "/health"):
            active_model = OLLAMA_MODEL if VISION_PROVIDER == "ollama" else MODEL_ID
            self.send_json(200, {"ok": True, "provider": VISION_PROVIDER, "model": active_model, "loaded": MODEL is not None if VISION_PROVIDER == "mlx" else True, "discogsConfigured": bool(DISCOGS_TOKEN)})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/collection/sync":
            try:
                request = self.read_json()
                records = sync_collection(request.get("records", []))
                self.send_json(200, {"ok": True, "count": len(records)})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return
        if parsed.path == "/collection/import-discogs":
            try:
                request = self.read_json()
                imported = parse_discogs_csv(str(request.get("csv", "")))
                existing = collection_records()
                sync_collection(existing + imported)
                self.send_json(200, {"records": imported, "count": len(imported)})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return
        if parsed.path == "/scan-sessions":
            try:
                self.send_json(200, {"session": save_scan_session(self.read_json())})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return
        if parsed.path != "/analyze":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            request = self.read_json()
            result = analyze(request["image"], request.get("prompt", PROMPT))
            self.send_json(200, result)
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_DELETE(self):
        match = re.fullmatch(r"/scan-sessions/([^/]+)", urlparse(self.path).path)
        if not match:
            self.send_json(404, {"error": "Not found"})
            return
        with database_connection() as connection:
            connection.execute("DELETE FROM scan_sessions WHERE id = ?", (match.group(1),))
        self.send_json(200, {"ok": True})

    def log_message(self, fmt, *args):
        print(f"[vision] {self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    initialize_database()
    print(f"Groovekeeper vision service on http://{HOST}:{PORT}")
    print(f"Vision provider: {VISION_PROVIDER}")
    print(f"Model: {OLLAMA_MODEL if VISION_PROVIDER == 'ollama' else MODEL_ID}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
