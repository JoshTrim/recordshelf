// Local development talks directly to the Python service.
globalThis.RECORDSHELF_API_BASE = `http://${location.hostname || "127.0.0.1"}:8765`;
