# RecordShelf

Local-first vinyl collection manager with shelf-photo recognition, cover and barcode identification, Discogs pressing lookup, pricing, duplicate resolution, and a persistent SQLite collection.

By default, the application, database, and vision model run on your own machine or home server. Discogs lookup requires outbound access to the Discogs API. An optional Mistral OCR provider can send cropped shelf images to Mistral for higher-accuracy OCR.

## Docker Compose deployment

These instructions deploy RecordShelf on a Linux home server or NAS with Docker. Only the web port is published; the API, SQLite database and Ollama service remain inside the Compose network.

### Requirements

- Docker Engine with Docker Compose v2
- Git access to this private repository
- Around 5 GB free for images and the default vision model
- 8 GB RAM recommended; more helps image recognition
- A Discogs personal access token for pressing lookup, artwork and pricing
- A static LAN address or DHCP reservation for the server is recommended

Confirm Docker is available:

```sh
docker --version
docker compose version
```

### First-time installation

1. Clone the private repository and enter it:

   ```sh
   git clone https://github.com/JoshTrim/recordshelf.git
   cd recordshelf
   ```

   GitHub will require an account, SSH key or personal access token that can read the private repository.

2. Create the local environment file:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

3. Edit `.env` and set at least these values:

   ```dotenv
   GROOVEKEEPER_WEB_PORT=3002
   GROOVEKEEPER_DISCOGS_TOKEN=your_discogs_personal_access_token
   ```

   Change `GROOVEKEEPER_WEB_PORT` if that host port is already occupied. Keep `.env` private; it is excluded from Docker builds and Git.

4. Build and start the stack:

   ```sh
   docker compose up -d --build
   ```

5. With the default Ollama provider, the first start downloads the approximately 3.2 GB `qwen2.5vl:3b` vision model. Follow the one-time download and container startup:

   ```sh
   docker compose logs -f ollama-pull
   ```

   Press `Ctrl-C` after the model download completes; this does not stop the containers.

6. Check the deployment:

   ```sh
   docker compose ps
   docker compose exec web wget -qO- http://api:8765/health
   ```

   All long-running services should show as running or healthy. The health request should return JSON containing `"ok": true`.

7. Open RecordShelf from another device on the same network:

   ```text
   http://YOUR-SERVER-IP:PORT
   ```

   Replace `PORT` with `GROOVEKEEPER_WEB_PORT` from `.env`, for example `http://192.168.1.20:3002`.

If the page is unavailable from another device, allow the selected TCP port through the server firewall. Do not expose ports `8765` or `11434`; nginx proxies API and vision requests through the single web port.

### Common operations

```sh
# View status
docker compose ps

# Follow application and model logs
docker compose logs -f web api ollama

# Restart without rebuilding
docker compose restart

# Stop the application while preserving all data
docker compose down

# Start it again
docker compose up -d
```

Avoid `docker compose down -v` unless you deliberately want to remove the SQLite collection and downloaded Ollama models.

### Shelf recognition pipeline

Shelf scans use OpenCV locally to detect long jacket edges and form narrow spine-aligned groups. Each uncertain group is retried in the opposite orientation with enhanced contrast and a local OCR hint. Instruction-like model output and unsupported artist/title guesses are discarded, then the strongest evidence from each group is matched against Discogs. Only rows independently corroborated by OCR start selected in the review screen.

Wide photos still have a physical resolution limit. For best results, fill the frame with 10–20 spines per photo and take several overlapping photos of a large shelf.

### Mistral OCR provider

The linked Mistral OCR service is an API rather than a local model. To use the current `mistral-ocr-latest` provider instead of Ollama, set these values in `.env`:

```sh
GROOVEKEEPER_VISION_PROVIDER=mistral
GROOVEKEEPER_MISTRAL_API_KEY=your_key
```

Shelf crops are sent to Mistral’s OCR API and returned as structured artist/title records. The Compose setup skips downloading the Ollama model when this provider is selected.

### NVIDIA GPU

With the NVIDIA Container Toolkit installed:

```sh
docker compose -f compose.yaml -f compose.nvidia.yaml up -d --build
```

Without that override, Ollama runs on CPU. Recognition will work but can be slow.

### Persistent data

- `groovekeeper_data` contains the SQLite database.
- `ollama_models` contains the local vision model.

Normal container updates do not remove either volume. Back up the database with:

```sh
docker compose exec api python3 -c "import shutil; shutil.copy2('/data/groovekeeper.sqlite3', '/data/groovekeeper-backup.sqlite3')"
docker cp groovekeeper-api:/data/groovekeeper-backup.sqlite3 ./groovekeeper-backup.sqlite3
```

You can also export CSV or JSON from the collection page.

### Updating

```sh
git pull --ff-only
docker compose up -d --build --remove-orphans
docker compose ps
```

Compose reuses both named volumes during rebuilds, so application updates do not erase the collection or redownload an unchanged Ollama model.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROOVEKEEPER_WEB_PORT` | `3002` | Browser UI port |
| `GROOVEKEEPER_VISION_PROVIDER` | `ollama` | `ollama`, `mistral`, or `mlx` |
| `GROOVEKEEPER_MISTRAL_API_KEY` | empty | Optional Mistral OCR API key |
| `GROOVEKEEPER_MISTRAL_OCR_MODEL` | `mistral-ocr-latest` | Mistral OCR model alias |
| `GROOVEKEEPER_OLLAMA_MODEL` | `qwen2.5vl:3b` | Ollama vision model |
| `GROOVEKEEPER_OLLAMA_CONTEXT` | `2048` | Vision context size; keep this low on memory-constrained servers |
| `GROOVEKEEPER_OLLAMA_NUM_PREDICT` | `320` | Maximum response tokens per vision panel |
| `GROOVEKEEPER_OLLAMA_KEEP_ALIVE` | `2m` | Time the model remains loaded after a request |
| `GROOVEKEEPER_DISCOGS_TOKEN` | empty | Discogs access token |

### Ollama stops with `unexpected EOF`

This normally means the model runner was killed under memory pressure. The default Compose configuration limits Ollama to one model and one request, uses a 2048-token context, quantizes the context cache, and retries one failed request with a smaller allocation.

After updating, rebuild the containers:

```sh
git pull
docker compose up -d --build
docker compose logs --tail=200 ollama
```

If the logs still show the runner being killed, check the host's available RAM while scanning with `docker stats`. Adding swap can prevent abrupt termination on small CPU-only servers, though it will make recognition slower.

### Browser reports a network error

Check each hop inside the Compose network:

```sh
docker compose ps
docker compose logs --tail=200 web api ollama
docker compose exec web wget -S -O- http://api:8765/health
docker compose exec web wget -S -O- http://127.0.0.1:3002/api/health
```

If the direct API health check succeeds but the nginx `/api/health` check fails, rebuild the web container. If both fail, inspect the API and Ollama logs for a restart, out-of-memory event or incomplete model download.

## Mac development

The existing local launcher continues to use Apple MLX:

```sh
npm run start
```

Open `http://localhost:3002`.
