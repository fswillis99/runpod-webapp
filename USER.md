# RunPod Image Generator — User Manual

## Overview

RunPod Image Generator is a browser-based tool for generating AI images through a RunPod serverless ComfyUI endpoint. It supports multiple generation workflows, a browseable history, image libraries, and RunPod credit tracking — all from a single page with no sign-in required.

---

## Getting Started

### Prerequisites

- Node.js 18 or later
- A RunPod account with a serverless ComfyUI endpoint deployed

### Installation

```bash
git clone https://github.com/fswillis99/runpod-webapp.git
cd runpod-webapp
npm install
```

### Configuration

Create a `.env` file in the project root with your credentials:

```env
RUNPOD_API_KEY=your_runpod_api_key
RUNPOD_ENDPOINT_ID=your_endpoint_id
MODEL_NAME=flux1-dev-fp8.safetensors
PORT=3000
```

- `RUNPOD_API_KEY` — found in your RunPod account settings under API Keys
- `RUNPOD_ENDPOINT_ID` — the ID of your deployed serverless endpoint
- `MODEL_NAME` — the Flux checkpoint filename (used only for Flux Dev workflow)
- `PORT` — defaults to 3000 if omitted

### Starting the Server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

**Windows users:** Double-click `start.bat` instead.

---

## Interface Layout

The page is divided into two panels:

- **Left panel** — workflow controls and the Generate button
- **Right panel** — the generated image display

The **header** shows the app title and your current RunPod credit balance (refreshed automatically after each generation).

---

## Workflows

Select a workflow from the dropdown at the top of the left panel. Each workflow targets a different model and use case.

### Flux Dev

Standard text-to-image generation using the Flux checkpoint.

| Field | Description |
|---|---|
| Prompt | Describe what you want to generate |
| Negative prompt | Describe what to exclude from the image |
| Width / Height | Output image dimensions in pixels |
| Steps | Number of diffusion steps (more = higher quality, slower) |
| Guidance | How closely the model follows your prompt (CFG scale) |

### Qwen-Image 2512

Text-to-image with the Qwen model. Runs in turbo mode (6 steps with Lightning LoRA) for faster generation.

| Field | Description |
|---|---|
| Prompt | Describe what you want to generate |
| Negative prompt | Describe what to exclude |
| Width / Height | Output image dimensions in pixels |

### Qwen-Image 2511

Image editing — provide a source image and a prompt describing the desired transformation.

| Field | Description |
|---|---|
| Prompt | Describe the edit or transformation |
| Negative prompt | Describe what to exclude |
| Image upload | The source image to edit (PNG or JPG) |

To upload a source image, click the upload area or drag and drop a file onto it.

---

## Generating an Image

1. Choose a workflow from the dropdown.
2. Fill in the prompt and any other required fields.
3. Click **Generate**.
4. A progress indicator appears while the job runs. Generation typically takes 15–60 seconds depending on the workflow and RunPod load.
5. The generated image appears in the right panel when complete.
6. Your credit balance is updated in the header.

---

## Generation History

The last 20 generated images are displayed below the main workspace, sorted newest first. Each card shows the image thumbnail, the prompt used, and the workflow type.

**Click any history card** to restore its settings — the workflow type, prompt, and parameters are loaded back into the form, and the image is shown in the right panel.

### Deleting a History Entry

Click the delete icon on a history card to move it to the trash. The image file is moved to the trash folder and can be restored from the Trash panel (see below).

---

## Image Download

### Single image

Click the **Download** button (or the image itself) to save the currently displayed image. The original ComfyUI filename is preserved.

### Multiple images

Check the selection boxes on history cards to select multiple images, then click **Download selected**. The images are packaged as a ZIP file.

If you select more than 10 images, you will be prompted to confirm before the ZIP is prepared.

---

## Image Libraries

Libraries let you organise saved images into named collections separate from the generation history.

### Creating a Library

Click **New Library** in the Libraries panel and enter a name.

### Adding Images to a Library

There are three ways to add images:

- **Save from history** — on any history card, click the library icon to save that image into a library you select.
- **Upload** — click **Upload** in a library to add a PNG or JPG file from your computer. Any embedded prompt metadata is read automatically.
- **Import from disk** — click **Import** to scan the library's folder for image files that aren't yet registered and add them all at once.

### Viewing a Library

Click a library name to open it. Images are displayed as thumbnails. Click a thumbnail to view the full image and its metadata.

### Deleting a Library Entry

Select images in the library view and click **Delete** to remove them from the library. (The files are moved to trash, not permanently deleted.)

---

## Trash

Deleted history entries and library images are moved to the Trash rather than permanently deleted.

Open the **Trash** panel to see all trashed items.

- **Restore** — moves the image back to its original location (history or library).
- **Delete permanently** — removes the image file and its metadata record for good.

---

## Timing Records

Every generation is logged with:

- The workflow type
- The prompt
- Execution time (wall-clock seconds from submit to completion)
- Your RunPod credit balance at the time of generation

Open the **Timing** panel to see the full table. Columns are sortable. Use this to track credit consumption over time and compare workflow performance.

---

## PNG Metadata

Every image generated by this app has metadata embedded directly in the PNG file as iTXt chunks:

| Chunk key | Contents |
|---|---|
| `prompt` | The positive prompt used |
| `workflow_type` | The workflow name (`flux`, `qwen2512`, `qwen2511`, or `manual`) |
| `loras` | Comma-separated list of LoRA models applied |

This metadata is read back automatically when you upload or import an image into a library, so prompts and workflow types are preserved.

Images uploaded from outside the app (without embedded metadata) are tagged with `workflow_type: manual`.

---

## Inspecting a Workflow Payload (Advanced)

You can preview the ComfyUI workflow graph that would be sent to RunPod without actually submitting a job:

```bash
curl -s -X POST http://localhost:3000/api/preview-workflow \
  -H 'Content-Type: application/json' \
  -d '{"workflowType":"flux","prompt":"a sunset over mountains","width":1024,"height":1024}' \
  | jq .
```

This is useful for debugging or verifying workflow parameters before running a paid generation.

---

## Troubleshooting

**Generation fails immediately**
- Check that your `.env` file exists and contains valid `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` values.
- Confirm your RunPod endpoint is active (not idle or stopped) in the RunPod dashboard.

**Balance shows "—"**
- The app couldn't reach the RunPod credits API. Check your API key and internet connection. The app continues to function normally without balance data.

**Image upload not accepted**
- Only PNG and JPG files are supported. Verify the file format before uploading.

**Server changes don't appear**
- Restart `npm start` after any change to `server.js`. The frontend updates on a browser refresh.

**Port already in use**
- Change the `PORT` value in `.env` and restart the server.
