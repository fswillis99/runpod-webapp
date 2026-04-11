require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' })); // images arrive as base64
app.use(express.static('public'));

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const MODEL_NAME = process.env.MODEL_NAME || 'flux1-dev-fp8.safetensors';
const BASE_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

// ---------------------------------------------------------------------------
// History (persisted to history.json, newest first, max 20 entries)
// ---------------------------------------------------------------------------
const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY = 20;

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

app.post('/api/history', (req, res) => {
  const { prompt, negative_prompt, filename, image, timestamp } = req.body;
  const history = loadHistory();
  history.unshift({ id: Date.now(), timestamp, prompt, negative_prompt, filename, image });
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  saveHistory(history);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Workflow builder
// ---------------------------------------------------------------------------
function buildWorkflow({ prompt, negative_prompt, width, height, steps, guidance, seed }) {
  return {
    "1": {
      inputs: { ckpt_name: MODEL_NAME },
      class_type: "CheckpointLoaderSimple",
    },
    "2": {
      inputs: { text: prompt || "", clip: ["1", 1] },
      class_type: "CLIPTextEncode",
    },
    "3": {
      inputs: { text: negative_prompt || "", clip: ["1", 1] },
      class_type: "CLIPTextEncode",
    },
    "4": {
      inputs: { guidance: guidance ?? 3.5, conditioning: ["2", 0] },
      class_type: "FluxGuidance",
    },
    "5": {
      inputs: { width: width ?? 1024, height: height ?? 1024, batch_size: 1 },
      class_type: "EmptySD3LatentImage",
    },
    "6": {
      inputs: {
        seed: seed ?? Math.floor(Math.random() * 2**32),
        steps: steps ?? 20,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["3", 0],
        latent_image: ["5", 0],
      },
      class_type: "KSampler",
    },
    "7": {
      inputs: { samples: ["6", 0], vae: ["1", 2] },
      class_type: "VAEDecode",
    },
    "8": {
      inputs: { filename_prefix: "ComfyUI", images: ["7", 0] },
      class_type: "SaveImage",
    },
  };
}

function buildFilenamePrefix() {
  const workflowName = MODEL_NAME.replace(/\.[^.]+$/, '');
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${workflowName}-${timestamp}`;
}

// ---------------------------------------------------------------------------
// RunPod proxy
// ---------------------------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  const { prompt, negative_prompt, width, height, steps, guidance, seed } = req.body;
  const workflow = buildWorkflow({ prompt, negative_prompt, width, height, steps, guidance, seed });
  workflow["8"].inputs.filename_prefix = buildFilenamePrefix();
  try {
    const response = await fetch(`${BASE_URL}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: { workflow } }),
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  try {
    const response = await fetch(`${BASE_URL}/status/${req.params.jobId}`, { headers });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
