require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const MODEL_NAME = process.env.MODEL_NAME || 'flux1-dev-fp8.safetensors';
const BASE_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

// Build a ComfyUI Flux Dev workflow with injected parameters.
// Node layout:
//   "1"  CheckpointLoaderSimple
//   "2"  CLIPTextEncode (positive prompt)
//   "3"  CLIPTextEncode (negative prompt, empty for Flux)
//   "4"  FluxGuidance
//   "5"  EmptySD3LatentImage
//   "6"  KSampler
//   "7"  VAEDecode
//   "8"  SaveImage
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
  const workflowName = MODEL_NAME.replace(/\.[^.]+$/, ''); // strip extension
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${workflowName}-${timestamp}`;
}

// Submit a generation job
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
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Poll job status / retrieve result
app.get('/api/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    const response = await fetch(`${BASE_URL}/status/${jobId}`, { headers });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
