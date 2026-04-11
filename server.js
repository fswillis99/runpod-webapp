require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const BASE_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

// Submit a generation job
app.post('/api/generate', async (req, res) => {
  const { prompt, negative_prompt, width, height, steps, guidance_scale } = req.body;

  const payload = {
    input: {
      prompt: prompt || '',
      negative_prompt: negative_prompt || 'blurry, bad quality',
      width: width || 512,
      height: height || 512,
      num_inference_steps: steps || 20,
      guidance_scale: guidance_scale || 7.5,
    },
  };

  try {
    const response = await fetch(`${BASE_URL}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
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
