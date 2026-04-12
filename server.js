require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "15mb" })); // images arrive as base64
app.use(express.static("public"));

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const MODEL_NAME = process.env.MODEL_NAME || "flux1-dev-fp8.safetensors";
const BASE_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
};

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------
app.get("/api/credits", async (req, res) => {
  try {
    const response = await fetch(
      `https://api.runpod.io/graphql?api_key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ myself { clientBalance } }" }),
      },
    );
    const data = await response.json();
    const balance = data.data?.myself?.clientBalance ?? null;
    res.json({ credits: balance === null ? null : balance.toFixed(2) });
  } catch (err) {
    console.error("Credits API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// History (persisted to history.json, newest first, max 20 entries)
// ---------------------------------------------------------------------------
const HISTORY_FILE = path.join(__dirname, "history.json");
const MAX_HISTORY = 20;

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

app.get("/api/history", (req, res) => {
  res.json(loadHistory());
});

app.post("/api/history", (req, res) => {
  const { prompt, negative_prompt, workflow_type, filename, image, timestamp } =
    req.body;
  const history = loadHistory();
  history.unshift({
    id: Date.now(),
    timestamp,
    prompt,
    negative_prompt,
    workflow_type,
    filename,
    image,
  });
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  saveHistory(history);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Workflow builders
// ---------------------------------------------------------------------------
function buildFilenamePrefix(workflowName) {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const timestamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${workflowName}-${timestamp}`;
}

function buildWorkflowFlux({
  prompt,
  negative_prompt,
  width,
  height,
  steps,
  guidance,
  seed,
}) {
  return {
    1: {
      inputs: { ckpt_name: MODEL_NAME },
      class_type: "CheckpointLoaderSimple",
    },
    2: {
      inputs: { text: prompt || "", clip: ["1", 1] },
      class_type: "CLIPTextEncode",
    },
    3: {
      inputs: { text: negative_prompt || "", clip: ["1", 1] },
      class_type: "CLIPTextEncode",
    },
    4: {
      inputs: { guidance: guidance ?? 3.5, conditioning: ["2", 0] },
      class_type: "FluxGuidance",
    },
    5: {
      inputs: { width: width ?? 1024, height: height ?? 1024, batch_size: 1 },
      class_type: "EmptySD3LatentImage",
    },
    6: {
      inputs: {
        seed: seed ?? Math.floor(Math.random() * 2 ** 32),
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
    7: {
      inputs: { samples: ["6", 0], vae: ["1", 2] },
      class_type: "VAEDecode",
    },
    8: {
      inputs: { filename_prefix: "ComfyUI", images: ["7", 0] },
      class_type: "SaveImage",
    },
  };
}

// Qwen-Image 2512 — text-to-image (turbo mode, 6 steps)
function buildWorkflowQwen2512({
  prompt,
  negative_prompt,
  width,
  height,
  seed,
}) {
  const w = width ?? 1328;
  const h = height ?? 1328;
  return {
    219: {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        type: "qwen_image",
      },
    },
    220: {
      class_type: "VAELoader",
      inputs: { vae_name: "qwen_image_vae.safetensors" },
    },
    226: {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "qwen_image_2512_fp8_e4m3fn.safetensors",
        weight_dtype: "default",
      },
    },
    221: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["226", 0],
        lora_name: "Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors",
        strength_model: 1,
      },
    },
    245: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["221", 0],
        lora_name: "Qwen4Play-2512.1_e10.safetensors",
        strength_model: 1,
      },
    },
    248: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["245", 0],
        lora_name: "qwen-image_nsfw_adv_v1.0.safetensors",
        strength_model: 0.6,
      },
    },
    249: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["248", 0],
        lora_name: "spanking_Qwen-dim64-v1.safetensors",
        strength_model: 1,
      },
    },
    250: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["249", 0],
        lora_name: "Korean_qwen.safetensors",
        strength_model: 0.6,
      },
    },
    222: {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["250", 0], shift: 3.1 },
    },
    227: {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt || "", clip: ["219", 0] },
    },
    228: {
      class_type: "CLIPTextEncode",
      inputs: {
        text: negative_prompt || "低分辨率，低画质，肢体畸形，手指畸形",
        clip: ["219", 0],
      },
    },
    232: {
      class_type: "EmptySD3LatentImage",
      inputs: { width: w, height: h, batch_size: 1 },
    },
    230: {
      class_type: "KSampler",
      inputs: {
        model: ["222", 0],
        positive: ["227", 0],
        negative: ["228", 0],
        latent_image: ["232", 0],
        seed: seed ?? Math.floor(Math.random() * 2 ** 32),
        steps: 6,
        cfg: 1,
        sampler_name: "res_multistep",
        scheduler: "simple",
        denoise: 1,
      },
    },
    231: {
      class_type: "VAEDecode",
      inputs: { samples: ["230", 0], vae: ["220", 0] },
    },
    60: {
      class_type: "SaveImage",
      inputs: { images: ["231", 0], filename_prefix: "ComfyUI" },
    },
  };
}

// Qwen-Image 2511 — image edit (turbo mode, 6 steps)
function buildWorkflowQwen2511({ prompt, image_filename, seed }) {
  const fname = image_filename || "input.png";
  return {
    83: {
      class_type: "LoadImage",
      inputs: { image: fname, upload: "image" },
    },
    162: {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        type: "qwen_image",
      },
    },
    146: {
      class_type: "VAELoader",
      inputs: { vae_name: "qwen_image_vae.safetensors" },
    },
    161: {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "qwen_image_edit_2511_bf16.safetensors",
        weight_dtype: "fp8_e4m3fn",
      },
    },
    160: {
      class_type: "FluxKontextImageScale",
      inputs: { image: ["83", 0] },
    },
    // Negative conditioning (empty prompt, image1 = scaled, image2 = original)
    149: {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        prompt: "",
        clip: ["162", 0],
        vae: ["146", 0],
        image1: ["160", 0],
        image2: ["83", 0],
      },
    },
    // Positive conditioning (edit instruction, image1 = scaled, image2 = original)
    151: {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        prompt: prompt || "",
        clip: ["162", 0],
        vae: ["146", 0],
        image1: ["160", 0],
        image2: ["83", 0],
      },
    },
    147: {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: {
        conditioning: ["149", 0],
        reference_latents_method: "index_timestep_zero",
      },
    },
    148: {
      class_type: "FluxKontextMultiReferenceLatentMethod",
      inputs: {
        conditioning: ["151", 0],
        reference_latents_method: "index_timestep_zero",
      },
    },
    145: {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["161", 0], shift: 3.1 },
    },
    152: {
      class_type: "CFGNorm",
      inputs: { model: ["145", 0], strength: 1 },
    },
    153: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["152", 0],
        lora_name:
          "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
        strength_model: 1,
      },
    },
    171: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["153", 0],
        lora_name: "Qwen4Play-2512.1_e10.safetensors",
        strength_model: 1,
      },
    },
    172: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["171", 0],
        lora_name: "qwen-image_nsfw_adv_v1.0.safetensors",
        strength_model: 1,
      },
    },
    173: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["172", 0],
        lora_name: "spanking_Qwen-dim64-v1.safetensors",
        strength_model: 1,
      },
    },
    174: {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["173", 0],
        lora_name: "Korean_qwen.safetensors",
        strength_model: 0.6,
      },
    },
    156: {
      class_type: "VAEEncode",
      inputs: { pixels: ["160", 0], vae: ["146", 0] },
    },
    169: {
      class_type: "KSampler",
      inputs: {
        model: ["174", 0],
        positive: ["148", 0],
        negative: ["147", 0],
        latent_image: ["156", 0],
        seed: seed ?? Math.floor(Math.random() * 2 ** 32),
        steps: 6,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
    },
    158: {
      class_type: "VAEDecode",
      inputs: { samples: ["169", 0], vae: ["146", 0] },
    },
    9: {
      class_type: "SaveImage",
      inputs: { images: ["158", 0], filename_prefix: "ComfyUI" },
    },
  };
}

// ---------------------------------------------------------------------------
// RunPod proxy
// ---------------------------------------------------------------------------
app.post("/api/generate", async (req, res) => {
  const {
    workflowType = "flux",
    prompt,
    negative_prompt,
    width,
    height,
    steps,
    guidance,
    seed,
    image,
  } = req.body;

  let workflow, input;

  if (workflowType === "qwen2512") {
    workflow = buildWorkflowQwen2512({
      prompt,
      negative_prompt,
      width,
      height,
      seed,
    });
    workflow["60"].inputs.filename_prefix = buildFilenamePrefix("qwen2512");
    input = { workflow };
  } else if (workflowType === "qwen2511") {
    const image_filename = "input.png";
    workflow = buildWorkflowQwen2511({ prompt, image_filename, seed });
    workflow["9"].inputs.filename_prefix = buildFilenamePrefix("qwen2511");
    input = {
      workflow,
      images: image ? [{ name: image_filename, image }] : [],
    };
  } else {
    // flux (default)
    workflow = buildWorkflowFlux({
      prompt,
      negative_prompt,
      width,
      height,
      steps,
      guidance,
      seed,
    });
    workflow["8"].inputs.filename_prefix = buildFilenamePrefix(
      MODEL_NAME.replace(/\.[^.]+$/, ""),
    );
    input = { workflow };
  }

  try {
    const response = await fetch(`${BASE_URL}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/status/:jobId", async (req, res) => {
  try {
    const response = await fetch(`${BASE_URL}/status/${req.params.jobId}`, {
      headers,
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`),
);
