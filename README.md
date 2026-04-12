# runpod-webapp

A simple Node.js/Express web app for generating images via a RunPod serverless ComfyUI endpoint. Supports multiple workflows, browseable history, and RunPod credit balance display.

## Features

- **Multiple workflows** — Flux Dev (text-to-image), Qwen-Image 2512 (text-to-image), Qwen-Image 2511 (image edit with upload)
- **Side-by-side layout** — form on the left, generated image on the right
- **Generation history** — last 20 images with prompts, sorted newest first; click any card to restore
- **Image download** — preserves the original filename from ComfyUI
- **RunPod credit balance** — displayed in the header, refreshed after each generation

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
```

`MODEL_NAME` is used for Flux Dev workflow filenames only.

### Running

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

**On Windows**, double-click `start.bat`.

## Workflows

| Workflow | Input | Notes |
|---|---|---|
| **Flux Dev** | Prompt, negative prompt, dimensions, steps, guidance | Standard Flux checkpoint |
| **Qwen-Image 2512** | Prompt, dimensions | Turbo mode (6 steps, Lightning LoRA) |
| **Qwen-Image 2511** | Prompt + image upload | Image editing, turbo mode (6 steps) |

## Project Structure

```
server.js       # Express server — proxies RunPod API, manages history and credits
public/
  index.html    # Single-page UI
history.json    # Persisted generation history (auto-created, gitignored)
.env            # Credentials (gitignored)
start.bat       # Windows launcher
```
