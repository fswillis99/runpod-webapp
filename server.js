require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const MODEL_NAME = process.env.MODEL_NAME || 'sd_xl_turbo_1.0_fp16.safetensors';
const BASE_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

// Build a ComfyUI SDXL Turbo workflow with injected parameters.
// Node layout:
//   "3" KSampler  "4" CheckpointLoaderSimple  "5" EmptyLatentImage
//   "6" CLIPTextEncode (positive)  "7" CLIPTextEncode (negative)
//   "8" VAEDecode  "9" SaveImage
function buildWorkflow({ prompt, negative_prompt, width, height, steps, cfg, seed }) {
  return {
    "3": {
      inputs: {
        seed: seed ?? Math.floor(Math.random() * 2**32),
        steps: steps ?? 3,
        cfg: cfg ?? 1.5,
        sampler_name: "euler_ancestral",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
      class_type: "KSampler",
    },
    "4": {
      inputs: { ckpt_name: MODEL_NAME },
      class_type: "CheckpointLoaderSimple",
    },
    "5": {
      inputs: { width: width ?? 1024, height: height ?? 1024, batch_size: 1 },
      class_type: "EmptyLatentImage",
    },
    "6": {
      inputs: { text: prompt || "", clip: ["4", 1] },
      class_type: "CLIPTextEncode",
    },
    "7": {
      inputs: { text: negative_prompt || "text, watermark, blurry, ugly, deformed", clip: ["4", 1] },
      class_type: "CLIPTextEncode",
    },
    "8": {
      inputs: { samples: ["3", 0], vae: ["4", 2] },
      class_type: "VAEDecode",
    },
    "9": {
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
      class_type: "SaveImage",
    },
  };
}

// Submit a generation job
app.post('/api/generate', async (req, res) => {
  const { prompt, negative_prompt, width, height, steps, cfg, seed } = req.body;

  const workflow = buildWorkflow({ prompt, negative_prompt, width, height, steps, cfg, seed });

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
