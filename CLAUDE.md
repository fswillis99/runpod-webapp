# CLAUDE.md — runpod-webapp

## Project overview

Single-file Node.js/Express server (`server.js`) + a single-page HTML UI (`public/index.html`). The server proxies RunPod's serverless API, manages local JSON data files, and stores generated images on disk. There is no build step and no framework beyond Express.

## Tech stack

- **Runtime**: Node.js 18+, Express
- **HTTP client**: `node-fetch`
- **Frontend**: Vanilla JS, single HTML file (`public/index.html`)
- **Persistence**: JSON files on disk (`history.json`, `libraries.json`, `execution_times.json`, `trash.json`)
- **Image storage**: `images/` directory (generated), `images/lib/` (libraries), `images/trash/` (trash)

## Key conventions

### PNG metadata
Every generated image has prompt, workflow type, and LoRA list embedded as **iTXt chunks**. Helper functions `makePngItxtChunk`, `readPngItxtChunks`, and `addPngMetadata` in `server.js` handle encoding/decoding. When uploading an external image, the server reads these chunks to auto-populate library entry fields; if no `prompt` chunk is found, `workflow_type` is set to `"manual"`.

### Data files
All JSON files are auto-created on first use. They are gitignored and should never be committed.

| File | Contents |
|---|---|
| `history.json` | Last 20 generation records (prompt, filename, timestamp, etc.) |
| `libraries.json` | Library definitions and their entries |
| `execution_times.json` | Per-generation timing + RunPod credit balance at time of generation |
| `trash.json` | Manifest of trashed images (path, original metadata) |

### API surface
All routes are in `server.js`. Key groups:

- `GET /api/credits` — fetch RunPod account balance
- `GET|POST /api/history` — read/append generation history
- `DELETE /api/history/:id` — move to trash
- `GET|POST /api/execution-times` — timing + balance records
- `GET|POST|DELETE /api/libraries` — library CRUD
- `POST /api/libraries/:id/entries` — add entry from existing generated image
- `POST /api/libraries/:id/upload` — upload a new image file into a library
- `POST /api/libraries/:id/import` — scan library directory and register untracked images
- `GET|POST|DELETE /api/trash` — trash management and restore
- `POST /api/preview-workflow` — return workflow JSON without submitting to RunPod
- `POST /api/generate` — submit generation job
- `GET /api/status/:jobId` — poll job status

### Workflow types
`workflowType` values used throughout: `flux`, `qwen2512`, `qwen2511`. The `buildWorkflow` function in `server.js` switches on this value to construct the ComfyUI graph.

## Development notes

- No test suite — test manually via the UI and `curl`.
- Restart the server after any change to `server.js`; the frontend reloads on browser refresh.
- The `images/`, `history.json`, `libraries.json`, `execution_times.json`, and `trash.json` are all gitignored; don't worry about them during commits.
- Keep `server.js` as a single file — resist splitting unless the file becomes unmanageable.
