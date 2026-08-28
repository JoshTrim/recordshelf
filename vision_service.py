#!/usr/bin/env python3
"""Tiny LAN-only vision service for Groovekeeper.

Run with: python3 vision_service.py
First request downloads the selected MLX model into the local Hugging Face cache.
"""
import base64
import csv
import http.client
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
OLLAMA_CONTEXT = int(os.environ.get("GROOVEKEEPER_OLLAMA_CONTEXT", "2048"))
OLLAMA_NUM_PREDICT = int(os.environ.get("GROOVEKEEPER_OLLAMA_NUM_PREDICT", "320"))
OLLAMA_KEEP_ALIVE = os.environ.get("GROOVEKEEPER_OLLAMA_KEEP_ALIVE", "2m")
MISTRAL_API_KEY = (os.environ.get("GROOVEKEEPER_MISTRAL_API_KEY") or os.environ.get("MISTRAL_API_KEY", "")).strip()
MISTRAL_OCR_MODEL = os.environ.get("GROOVEKEEPER_MISTRAL_OCR_MODEL", "mistral-ocr-latest")
MISTRAL_OCR_URL = os.environ.get("GROOVEKEEPER_MISTRAL_OCR_URL", "https://api.mistral.ai/v1/ocr").strip()
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


def detect_spine_segments(data_url):
    """Find long jacket edges and return narrow, spine-aligned scan groups."""
    try:
        import cv2
        import numpy as np
    except ImportError as error:
        raise RuntimeError("Automatic spine detection dependencies are unavailable") from error

    encoded = np.frombuffer(decode_image(data_url), dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("The shelf image could not be decoded")
    height, width = image.shape[:2]
    scale = min(1.0, 1600 / max(1, width))
    if scale < 1:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        height, width = image.shape[:2]

    shelf_top = round(height * 0.025)
    shelf_bottom = round(height * 0.965)
    shelf = image[shelf_top:shelf_bottom]
    gray = cv2.cvtColor(shelf, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 45, 130)
    minimum_line = max(40, round(shelf.shape[0] * 0.48))
    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 720,
        55,
        minLineLength=minimum_line,
        maxLineGap=max(25, round(shelf.shape[0] * 0.06)),
    )

    center_y = shelf.shape[0] / 2
    line_candidates = []
    for x1, y1, x2, y2 in lines.reshape(-1, 4) if lines is not None else []:
        dx, dy = float(x2 - x1), float(y2 - y1)
        length = (dx * dx + dy * dy) ** 0.5
        if abs(dy) < minimum_line or abs(dx) > abs(dy) * 0.32:
            continue
        center_x = float(x1) + (center_y - float(y1)) * dx / dy
        if 1 < center_x < width - 1:
            line_candidates.append((center_x, length))

    line_candidates.sort()
    clusters = []
    cluster_distance = max(4, round(width * 0.006))
    for x, score in line_candidates:
        if clusters and x - clusters[-1][0] / clusters[-1][2] <= cluster_distance:
            clusters[-1][0] += x * score
            clusters[-1][1] = max(clusters[-1][1], score)
            clusters[-1][2] += score
        else:
            clusters.append([x * score, score, score])
    candidates = [(cluster[0] / cluster[2], cluster[1]) for cluster in clusters]

    minimum_gap = max(6, round(width * 0.006))
    selected = []
    for x, score in candidates:
        if selected and x - selected[-1][0] < minimum_gap:
            if score > selected[-1][1]:
                selected[-1] = (x, score)
        else:
            selected.append((x, score))

    boundaries = [0] + [round(x) for x, _ in selected] + [width]
    boundaries = sorted(set(max(0, min(width, value)) for value in boundaries))
    atomic = [(left, right) for left, right in zip(boundaries, boundaries[1:]) if right - left >= minimum_gap]

    # Groups begin and end on detected jacket edges. This avoids cutting
    # lettering while keeping requests small enough for thin spine text.
    target_width = max(38, min(76, round(width * 0.055)))
    if atomic and width / target_width > 28:
        target_width = round(width / 28)
    maximum_width = round(target_width * 1.55)
    groups = []
    group_left = atomic[0][0] if atomic else 0
    group_right = group_left
    spine_count = 0
    for index, (left, right) in enumerate(atomic):
        if spine_count and right - group_left > maximum_width:
            groups.append((group_left, group_right, spine_count))
            group_left, spine_count = left, 0
        group_right = right
        spine_count += 1
        next_width = atomic[index + 1][1] - group_left if index + 1 < len(atomic) else maximum_width + 1
        if group_right - group_left >= target_width or next_width > maximum_width:
            groups.append((group_left, group_right, spine_count))
            if index + 1 < len(atomic):
                group_left = atomic[index + 1][0]
            spine_count = 0
    if spine_count:
        groups.append((group_left, group_right, spine_count))
    if len(groups) > 1 and groups[-1][1] - groups[-1][0] < target_width * 0.45:
        previous, last = groups[-2], groups[-1]
        groups[-2:] = [(previous[0], last[1], previous[2] + last[2])]

    if len(groups) < 3:
        fallback_width = max(80, min(150, round(width * 0.11)))
        stride = max(1, round(fallback_width * 0.82))
        starts = list(range(0, max(1, width - fallback_width), stride))
        starts.append(max(0, width - fallback_width))
        groups = [(x, min(width, x + fallback_width), 0) for x in dict.fromkeys(starts)]

    return {
        "sourceWidth": width,
        "sourceHeight": height,
        "shelfTop": shelf_top,
        "shelfHeight": shelf_bottom - shelf_top,
        "boundaryCount": max(0, len(boundaries) - 2),
        "segments": [
            {"x": left, "panelWidth": right - left, "spineCount": count}
            for left, right, count in groups[:28]
            if right > left
        ],
    }


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
        evidence = str(item.get("evidence", "")).strip()
        placeholders = {"...", "..", ".", "unknown", "n/a", "none", "artist", "title", "short visible text", "exact words visibly read"}
        if artist.casefold() in placeholders:
            artist = ""
        if title.casefold() in placeholders:
            title = ""
        if evidence.casefold() in placeholders:
            evidence = ""
        if artist and title and artist.casefold() == title.casefold():
            title = ""
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
            "evidence": evidence,
        })
    return unique[:40]


def analyze(data_url, prompt=PROMPT, provider=None):
    provider = (provider or VISION_PROVIDER).strip().lower()
    if provider == "ollama":
        return analyze_with_ollama(data_url, prompt)
    if provider in ("mistral", "mistral-ocr", "mistral_ocr"):
        return analyze_with_mistral_ocr(data_url, prompt)
    if provider != "mlx":
        raise RuntimeError(f"Unsupported vision provider: {provider}")

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
    last_error = None
    for attempt in range(2):
        # The retry uses an even smaller allocation. Vision OCR needs a short
        # JSON response rather than a general-purpose chat context.
        context = OLLAMA_CONTEXT if attempt == 0 else min(OLLAMA_CONTEXT, 1024)
        predict = OLLAMA_NUM_PREDICT if attempt == 0 else min(OLLAMA_NUM_PREDICT, 160)
        body = json.dumps({
            "model": OLLAMA_MODEL,
            "stream": False,
            "keep_alive": OLLAMA_KEEP_ALIVE,
            "messages": [{"role": "user", "content": prompt, "images": [image_data]}],
            "options": {"temperature": 0, "num_ctx": context, "num_predict": predict},
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
            output_text = str((payload.get("message") or {}).get("content") or "")
            return {"records": extract_json(output_text), "raw": output_text}
        except HTTPError as error:
            detail = error.read().decode(errors="replace")
            last_error = f"Ollama returned {error.code}: {detail}"
            retryable = error.code >= 500 or "unexpected eof" in detail.casefold()
        except (URLError, http.client.IncompleteRead, http.client.RemoteDisconnected, ConnectionResetError, json.JSONDecodeError) as error:
            last_error = f"Ollama connection ended while the model was running: {error}"
            retryable = True
        if attempt == 0 and retryable:
            time.sleep(2)
            continue
        break
    if "unexpected eof" in str(last_error).casefold() or "connection ended" in str(last_error).casefold():
        raise RuntimeError(
            "The Ollama model runner stopped unexpectedly, usually because the server ran out of RAM. "
            "RecordShelf retried with a smaller context but it stopped again. Check `docker compose logs ollama`."
        )
    raise RuntimeError(last_error or "Ollama did not return a response")


MISTRAL_RECORD_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "vinyl_record_detection",
        "description": "Readable artist and album titles from vinyl record imagery",
        "schema": {
            "type": "object",
            "properties": {
                "records": {
                    "type": "array",
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "properties": {
                            "artist": {"type": "string"},
                            "title": {"type": "string"},
                            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                            "evidence": {"type": "string"},
                        },
                        "required": ["artist", "title", "confidence", "evidence"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["records"],
            "additionalProperties": False,
        },
        "strict": True,
    },
}


def analyze_with_mistral_ocr(data_url, prompt=PROMPT):
    if not MISTRAL_API_KEY:
        raise RuntimeError("Mistral OCR is not configured. Set GROOVEKEEPER_MISTRAL_API_KEY.")
    annotation_prompt = (prompt or PROMPT).strip() + (
        "\nThe API schema controls the output format. Populate its records array. "
        "Use only lettering genuinely visible in the image; use empty strings for unknown fields "
        "and return no invented records."
    )
    if not str(data_url).startswith("data:"):
        data_url = f"data:image/jpeg;base64,{data_url}"
    body = json.dumps({
        "model": MISTRAL_OCR_MODEL,
        "document": {"type": "image_url", "image_url": data_url},
        "document_annotation_prompt": annotation_prompt,
        "document_annotation_format": MISTRAL_RECORD_SCHEMA,
    }).encode()
    request = Request(
        MISTRAL_OCR_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {MISTRAL_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=180) as response:
            payload = json.loads(response.read())
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("message", detail)
        except json.JSONDecodeError:
            pass
        raise RuntimeError(f"Mistral OCR returned {error.code}: {detail}") from error
    except (URLError, http.client.IncompleteRead, http.client.RemoteDisconnected, ConnectionResetError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not reach Mistral OCR: {error}") from error

    annotation = payload.get("document_annotation")
    if isinstance(annotation, str):
        try:
            annotation = json.loads(annotation)
        except json.JSONDecodeError:
            pass
    annotation_text = annotation if isinstance(annotation, str) else json.dumps(annotation)
    records = extract_json(annotation_text) if annotation is not None else []
    pages = payload.get("pages") or []
    page_text = "\n\n".join(str(page.get("markdown") or "") for page in pages if isinstance(page, dict)).strip()
    if not records and page_text:
        records = extract_json(page_text)
    raw = json.dumps({"annotation": annotation, "pages": page_text}, ensure_ascii=False)
    return {"records": records, "raw": raw}


def ollama_status():
    try:
        with urlopen(f"{OLLAMA_URL}/api/ps", timeout=3) as response:
            payload = json.loads(response.read())
        running = payload.get("models") or []
        return True, any(str(item.get("name") or item.get("model") or "").startswith(OLLAMA_MODEL) for item in running)
    except Exception:
        return False, False


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


def search_discogs(artist="", title="", barcode="", query=""):
    search_params = {
        "type": "release",
        "format": "Vinyl",
        "per_page": 12,
    }
    if barcode:
        search_params["barcode"] = re.sub(r"\D", "", barcode)
    elif query:
        search_params["q"] = query
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
            query = (params.get("q") or [""])[0].strip()
            barcode = re.sub(r"\D", "", (params.get("barcode") or [""])[0])
            if not artist and not title and not query and not barcode:
                self.send_json(400, {"error": "Artist, title, text query or barcode is required"})
                return
            try:
                self.send_json(200, {"releases": search_discogs(artist, title, barcode, query)})
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
            if VISION_PROVIDER == "ollama":
                active_model = OLLAMA_MODEL
                reachable, loaded = ollama_status()
            elif VISION_PROVIDER in ("mistral", "mistral-ocr", "mistral_ocr"):
                active_model = MISTRAL_OCR_MODEL
                reachable = bool(MISTRAL_API_KEY)
                loaded = reachable
            else:
                active_model = MODEL_ID
                reachable, loaded = True, MODEL is not None
            self.send_json(200 if reachable else 503, {"ok": reachable, "provider": VISION_PROVIDER, "model": active_model, "loaded": loaded, "discogsConfigured": bool(DISCOGS_TOKEN), "mistralConfigured": bool(MISTRAL_API_KEY)})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/segment-spines":
            try:
                request = self.read_json()
                self.send_json(200, detect_spine_segments(request["image"]))
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return
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
        provider = VISION_PROVIDER
        try:
            request = self.read_json()
            provider = str(request.get("provider") or VISION_PROVIDER)
            result = analyze(request["image"], request.get("prompt", PROMPT), provider)
            self.send_json(200, result)
        except Exception as error:
            self.send_json(503 if provider.strip().lower() in ("ollama", "mistral", "mistral-ocr", "mistral_ocr") else 500, {"error": str(error)})

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
