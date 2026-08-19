# Groovekeeper

Local-first vinyl collection manager with shelf-photo recognition, cover and barcode identification, Discogs pressing lookup, pricing, duplicate resolution, and a persistent SQLite collection.

Nothing is hosted externally. The application, database, and vision model run on your own machine or home server. Discogs lookup requires outbound access to the Discogs API.

## Docker Compose deployment

Requirements:

- Docker Engine with Docker Compose v2
- Around 5 GB free for images and the default vision model
- 8 GB RAM recommended; more helps image recognition
- A Discogs personal access token for pressing lookup and pricing

1. Clone the private repository and enter it.
2. Copy the environment template:

   ```sh
   cp .env.example .env
   ```

3. Put your Discogs token in `.env`.
4. Start the stack:

   ```sh
   docker compose up -d --build
   ```

The first start downloads the approximately 3.2 GB `qwen2.5vl:3b` vision model. Follow progress with:

```sh
docker compose logs -f ollama-pull
```

Open `http://YOUR-SERVER-IP:3002`. The API listens on port `8765`; both ports must be reachable by devices on your LAN.

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
git pull
docker compose up -d --build
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROOVEKEEPER_WEB_PORT` | `3002` | Browser UI port |
| `GROOVEKEEPER_API_PORT` | `8765` | Local API port |
| `GROOVEKEEPER_OLLAMA_MODEL` | `qwen2.5vl:3b` | Ollama vision model |
| `GROOVEKEEPER_DISCOGS_TOKEN` | empty | Discogs access token |

If you change the API port, update `serviceBase()` in `app.js` or keep the browser-facing port at `8765`.

## Mac development

The existing local launcher continues to use Apple MLX:

```sh
npm run start
```

Open `http://localhost:3002`.
