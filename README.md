# runpod-webapp

A Node.js/Express web app for generating images via a RunPod serverless ComfyUI endpoint. Supports multiple workflows, browseable history, image libraries, and RunPod credit tracking.

## Features

- **Multiple workflows** — Flux Dev (text-to-image), Qwen-Image 2512 (text-to-image), Qwen-Image 2511 (image edit with upload)
- **Side-by-side layout** — form on the left, generated image on the right
- **Generation history** — last 20 images with prompts, sorted newest first; click any card to restore
- **Image download** — single image preserves original ComfyUI filename; select multiple images to download as a ZIP (prompted automatically when >10 are selected)
- **Image libraries** — organise saved images into named libraries; import from disk or upload directly
- **Library upload** — upload any PNG/JPG to a library; iTXt metadata is read automatically, `workflow_type` is set to `manual` when no prompt is found
- **Trash & restore** — deleted images move to trash; restore or permanently delete from there
- **RunPod credit balance** — displayed in the header, refreshed after each generation
- **Timing records** — execution time and current account balance recorded for every generation; displayed in a sortable table
- **PNG metadata** — every generated image carries prompt, workflow type, and LoRA list embedded as iTXt chunks

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A RunPod account with a serverless ComfyUI endpoint

### Installation

```bash
git clone https://github.com/fswillis99/runpod-webapp.git
cd runpod-webapp
npm install
```

### Configuration

Create a `.env` file in the project root:

```env
RUNPOD_API_KEY=your_api_key
RUNPOD_ENDPOINT_ID=your_endpoint_id
MODEL_NAME=flux1-dev-fp8.safetensors
PORT=3000
RUNPOD_STARTING_BALANCE=30.45
RUNPOD_BALANCE_DATE=2026-08-22T02:25:07Z
```

`MODEL_NAME` is used for Flux Dev workflow filenames only.

#### Estimated balance (v2 billing)

`RUNPOD_STARTING_BALANCE` and `RUNPOD_BALANCE_DATE` anchor the RunPod REST API v2 billing estimate. The app subtracts all spend recorded by RunPod since `RUNPOD_BALANCE_DATE` from `RUNPOD_STARTING_BALANCE` to show an estimated current balance alongside the live balance in the header.

Whenever you top up your RunPod account:

1. Note the live balance shown in the UI header (the green **Credits** figure).
2. Update `RUNPOD_STARTING_BALANCE` to that value in `.env`.
3. Update `RUNPOD_BALANCE_DATE` to the current UTC timestamp (e.g. `2026-08-22T10:00:00Z`).
4. Restart the server.

If either variable is absent, the estimated balance shows `—`.

### Running

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

**On Windows**, double-click `start.bat`.

## Workflows

| Workflow            | Input                                                | Notes                                |
| ------------------- | ---------------------------------------------------- | ------------------------------------ |
| **Flux Dev**        | Prompt, negative prompt, dimensions, steps, guidance | Standard Flux checkpoint             |
| **Qwen-Image 2512** | Prompt, dimensions                                   | Turbo mode (6 steps, Lightning LoRA) |
| **Qwen-Image 2511** | Prompt + image upload                                | Image editing, turbo mode (6 steps)  |

## Inspecting the workflow payload

`POST /api/preview-workflow` accepts the same body as the generate endpoint and returns the fully-constructed ComfyUI workflow graph that would be sent to RunPod — without submitting a job.

```bash
curl -s -X POST http://localhost:3000/api/preview-workflow \
  -H 'Content-Type: application/json' \
  -d '{"workflowType":"qwen2512","prompt":"a cat","width":1024,"height":1024}' \
  | jq .
```

## Project Structure

```
server.js              # Express server — RunPod proxy, history, libraries, credits
public/
  index.html           # Single-page UI
images/                # Generated images (auto-created, gitignored)
  lib/                 # Library image storage
  trash/               # Trashed images
history.json           # Generation history (auto-created, gitignored)
libraries.json         # Library metadata (auto-created, gitignored)
execution_times.json   # Timing + balance records (auto-created, gitignored)
trash.json             # Trash manifest (auto-created, gitignored)
.env                   # Credentials (gitignored)
start.bat              # Windows launcher
```
