require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "15mb" })); // images arrive as base64
app.use(express.static("public"));

// ---------------------------------------------------------------------------
// Image file storage
// ---------------------------------------------------------------------------
const IMAGES_DIR = path.join(__dirname, "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);
const LIB_DIR = path.join(IMAGES_DIR, "lib");
if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR);
const TRASH_DIR = path.join(IMAGES_DIR, "trash");
if (!fs.existsSync(TRASH_DIR)) fs.mkdirSync(TRASH_DIR);
app.use("/images", express.static(IMAGES_DIR));

// CRC32 implementation for PNG chunk checksums
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Build a PNG iTXt chunk (supports UTF-8 text)
function makePngItxtChunk(keyword, text) {
  const data = Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0, 0, 0, 0, 0]), // null-term, comp_flag=0, comp_method=0, lang=null, trans_kw=null
    Buffer.from(String(text), "utf8"),
  ]);
  const type = Buffer.from("iTXt");
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crcBuf = Buffer.allocUnsafe(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([len, type, data, crcBuf]);
}

// Read iTXt metadata chunks from a PNG buffer, returning keyword→text map
function readPngItxtChunks(pngBuf) {
  const meta = {};
  if (pngBuf.length < 8) return meta;
  let offset = 8; // skip PNG signature
  while (offset + 12 <= pngBuf.length) {
    const chunkLen = pngBuf.readUInt32BE(offset);
    const chunkType = pngBuf.slice(offset + 4, offset + 8).toString("latin1");
    if (chunkType === "IEND") break;
    if (chunkType === "iTXt") {
      const data = pngBuf.slice(offset + 8, offset + 8 + chunkLen);
      let i = 0;
      while (i < data.length && data[i] !== 0) i++;
      const keyword = data.slice(0, i).toString("latin1");
      // skip null + comp_flag + comp_method = 3 bytes, then language tag (null-terminated)
      i += 3;
      while (i < data.length && data[i] !== 0) i++;
      i++; // skip null after language tag
      // skip translated keyword (null-terminated)
      while (i < data.length && data[i] !== 0) i++;
      i++; // skip null after translated keyword
      meta[keyword] = data.slice(i).toString("utf8");
    }
    offset += 12 + chunkLen;
  }
  return meta;
}

// Insert iTXt metadata chunks into a PNG buffer (before IEND)
function addPngMetadata(pngBuf, metadata) {
  const iendPos = pngBuf.length - 12; // IEND is always the last 12 bytes
  const chunks = Object.entries(metadata).map(([k, v]) => makePngItxtChunk(k, v));
  return Buffer.concat([pngBuf.slice(0, iendPos), ...chunks, pngBuf.slice(iendPos)]);
}

function saveImageFile(filename, base64, metadata) {
  let buf = Buffer.from(base64, "base64");
  buf = addPngMetadata(buf, metadata);
  fs.writeFileSync(path.join(IMAGES_DIR, filename), buf);
}

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
// Image URL proxy — fetches a remote image server-side to avoid CORS
// ---------------------------------------------------------------------------
app.get("/api/fetch-image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/png";
    if (!contentType.startsWith("image/")) throw new Error("URL did not return an image");
    const buffer = await response.buffer();
    if (buffer.length > 15 * 1024 * 1024) throw new Error("Image too large (max 15 MB)");
    res.json({ data: buffer.toString("base64"), contentType });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Image download — serves images with Content-Disposition: attachment so that
// Chrome on Windows triggers a file-save instead of an inline navigation.
// ?path= is relative to IMAGES_DIR; path traversal is rejected.
// ---------------------------------------------------------------------------
app.get("/api/download", (req, res) => {
  const rel = req.query.path;
  if (!rel || typeof rel !== "string") return res.status(400).end();
  const normalized = path.normalize(rel);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return res.status(403).end();
  const abs = path.join(IMAGES_DIR, normalized);
  res.download(abs, path.basename(abs), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------------------------------------------------------------------------
// History (persisted to history.json, newest first, max 200 entries)
// Images are stored separately in images/{id}.png
// ---------------------------------------------------------------------------
const HISTORY_FILE = path.join(__dirname, "history.json");
const MAX_HISTORY = 200;

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

// Migrate legacy history entries that have embedded base64 image data
function migrateHistory() {
  const history = loadHistory();
  let changed = false;
  for (const entry of history) {
    if (entry.image) {
      try {
        saveImageFile(entry.filename || `${entry.id}.png`, entry.image, {
          prompt: entry.prompt || "",
          workflow_type: entry.workflow_type || "",
          loras: Array.isArray(entry.loras) ? entry.loras.join(",") : "",
        });
      } catch (err) {
        console.warn(`Failed to migrate image for entry ${entry.id}:`, err.message);
      }
      delete entry.image;
      changed = true;
    }
  }
  if (changed) {
    saveHistory(history);
    console.log("Migrated embedded history images to image files.");
  }
}
migrateHistory();

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------
const TRASH_FILE = path.join(__dirname, "trash.json");
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function loadTrash() {
  try { return JSON.parse(fs.readFileSync(TRASH_FILE, "utf8")); }
  catch { return []; }
}

function saveTrash(entries) {
  fs.writeFileSync(TRASH_FILE, JSON.stringify(entries));
}

// Returns a trashId (number) that has no existing subdirectory in TRASH_DIR.
function generateTrashId() {
  let id;
  do { id = Date.now(); } while (fs.existsSync(path.join(TRASH_DIR, String(id))));
  return id;
}

function moveFilesToTrash(srcDir, filenames, trashEntryDir) {
  fs.mkdirSync(trashEntryDir, { recursive: true });
  for (const fname of filenames) {
    if (!fname) continue;
    const src = path.join(srcDir, fname);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(trashEntryDir, fname));
  }
}

function purgeOldTrash() {
  const trash = loadTrash();
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const keep = [];
  for (const entry of trash) {
    if (new Date(entry.deletedAt).getTime() < cutoff) {
      const dir = path.join(TRASH_DIR, String(entry.trashId));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } else {
      keep.push(entry);
    }
  }
  if (keep.length !== trash.length) saveTrash(keep);
}

purgeOldTrash();
setInterval(purgeOldTrash, 60 * 60 * 1000);

app.get("/api/trash", (req, res) => res.json(loadTrash()));

// Insert entry into a newest-first array at the correct chronological position.
function insertByDate(arr, entry) {
  const idx = arr.findIndex(e => e.id < entry.id);
  if (idx === -1) arr.push(entry); else arr.splice(idx, 0, entry);
}

app.post("/api/trash/:trashId/restore", (req, res) => {
  const trashId = parseInt(req.params.trashId, 10);
  const trash = loadTrash();
  const entry = trash.find(e => e.trashId === trashId);
  if (!entry) return res.status(404).json({ error: "trash entry not found" });

  const trashEntryDir = path.join(TRASH_DIR, String(trashId));
  const { source, libId, libName, libSlug, trashId: _tid, deletedAt: _da, ...originalEntry } = entry;

  const moveBack = (dstDir) => {
    const files = [originalEntry.filename, ...(originalEntry.input_images || [])].filter(Boolean);
    for (const f of files) {
      const src = path.join(trashEntryDir, f);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(dstDir, f));
    }
  };

  if (source === "history") {
    moveBack(IMAGES_DIR);
    const history = loadHistory();
    if (!history.some(e => e.id === originalEntry.id)) {
      insertByDate(history, originalEntry);
      if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
      saveHistory(history);
    }
  } else {
    const libs = loadLibraries();
    const lib = libs.find(l => l.id === libId);
    if (lib) {
      const dir = libDir(lib);
      fs.mkdirSync(dir, { recursive: true });
      moveBack(dir);
      lib.entries = lib.entries || [];
      if (!lib.entries.some(e => e.id === originalEntry.id)) {
        insertByDate(lib.entries, originalEntry);
      }
      saveLibraries(libs);
    } else {
      // Library gone — recreate it with the original slug and name
      const slug = libSlug || nameToSlug(libName || "restored") + "-" + String(Math.floor(1000 + Math.random() * 9000));
      const newLib = { id: libId, name: libName || slug, slug, entries: [] };
      const dir = path.join(LIB_DIR, slug);
      fs.mkdirSync(dir, { recursive: true });
      moveBack(dir);
      insertByDate(newLib.entries, originalEntry);
      libs.push(newLib);
      saveLibraries(libs);
    }
  }

  if (fs.existsSync(trashEntryDir)) fs.rmSync(trashEntryDir, { recursive: true, force: true });
  saveTrash(trash.filter(e => e.trashId !== trashId));

  res.json({ ok: true, restored_to: source });
});

app.delete("/api/trash/:trashId", (req, res) => {
  const trashId = parseInt(req.params.trashId, 10);
  const trash = loadTrash();
  if (!trash.some(e => e.trashId === trashId)) return res.status(404).json({ error: "not found" });
  const dir = path.join(TRASH_DIR, String(trashId));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  saveTrash(trash.filter(e => e.trashId !== trashId));
  res.json({ ok: true });
});

app.delete("/api/trash", (req, res) => {
  const trash = loadTrash();
  for (const entry of trash) {
    const dir = path.join(TRASH_DIR, String(entry.trashId));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  saveTrash([]);
  res.json({ ok: true });
});

app.get("/api/history", (req, res) => {
  res.json(loadHistory());
});

app.post("/api/history", (req, res) => {
  const { prompt, negative_prompt, workflow_type, loras, filename, image, input_images, timestamp } =
    req.body;
  const id = Date.now();
  if (image && filename) {
    saveImageFile(filename, image, {
      prompt: prompt || "",
      workflow_type: workflow_type || "",
      loras: Array.isArray(loras) ? loras.join(",") : "",
    });
  }
  // Save each input image as a sidecar file: {outputBase}-in{n}.png
  const savedInputFiles = [];
  if (Array.isArray(input_images) && input_images.length > 0 && filename) {
    const base = filename.replace(/\.[^.]+$/, "");
    for (let i = 0; i < input_images.length; i++) {
      const img = input_images[i];
      if (!img?.data) continue;
      const inputFilename = `${base}-in${i + 1}.png`;
      try {
        fs.writeFileSync(path.join(IMAGES_DIR, inputFilename), Buffer.from(img.data, "base64"));
        savedInputFiles.push(inputFilename);
      } catch (err) {
        console.warn(`Failed to save input image ${i + 1}:`, err.message);
      }
    }
  }
  const history = loadHistory();
  const entry = { id, timestamp, prompt, negative_prompt, workflow_type, loras, filename };
  if (savedInputFiles.length > 0) entry.input_images = savedInputFiles;
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  saveHistory(history);
  res.json({ ok: true });
});

app.delete("/api/history/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const history = loadHistory();
  const entry = history.find(e => e.id === id);
  saveHistory(history.filter(e => e.id !== id));
  if (entry) {
    const trashId = generateTrashId();
    const trashEntryDir = path.join(TRASH_DIR, String(trashId));
    const files = [entry.filename, ...(entry.input_images || [])].filter(Boolean);
    moveFilesToTrash(IMAGES_DIR, files, trashEntryDir);
    const trash = loadTrash();
    trash.push({ ...entry, trashId, deletedAt: new Date().toISOString(), source: "history", libId: null, libName: null, libSlug: null });
    saveTrash(trash);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------
const LIBRARIES_FILE = path.join(__dirname, "libraries.json");

function loadLibraries() {
  try { return JSON.parse(fs.readFileSync(LIBRARIES_FILE, "utf8")); }
  catch { return []; }
}
function saveLibraries(libs) { fs.writeFileSync(LIBRARIES_FILE, JSON.stringify(libs)); }

// Derive a safe cross-platform directory name from a library name.
// Keeps only alphanumerics and hyphens, collapses runs, trims ends.
function nameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "library";
}

// Resolve the filesystem directory for a library, with fallback for
// legacy libraries created before slugs were introduced.
function libDir(lib) {
  return path.join(LIB_DIR, lib.slug || String(lib.id));
}

app.get("/api/libraries", (req, res) => res.json(loadLibraries()));

app.post("/api/libraries", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const id = Date.now();
  // Append 4 random digits to guarantee uniqueness even for identical names.
  let slug;
  do {
    slug = nameToSlug(name) + "-" + String(Math.floor(1000 + Math.random() * 9000));
  } while (fs.existsSync(path.join(LIB_DIR, slug)));
  fs.mkdirSync(path.join(LIB_DIR, slug), { recursive: true });
  const libs = loadLibraries();
  libs.push({ id, name, slug, entries: [] });
  saveLibraries(libs);
  res.json({ id, name, slug });
});

app.delete("/api/libraries/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const libs = loadLibraries();
  const lib = libs.find(l => l.id === id);
  saveLibraries(libs.filter(l => l.id !== id));
  if (lib) {
    const dir = libDir(lib);
    const trash = loadTrash();
    for (const entry of (lib.entries || [])) {
      const trashId = generateTrashId();
      const trashEntryDir = path.join(TRASH_DIR, String(trashId));
      const files = [entry.filename, ...(entry.input_images || [])].filter(Boolean);
      moveFilesToTrash(dir, files, trashEntryDir);
      trash.push({ ...entry, trashId, deletedAt: new Date().toISOString(), source: "library", libId: id, libName: lib.name, libSlug: lib.slug || String(id) });
    }
    if ((lib.entries || []).length) saveTrash(trash);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  res.json({ ok: true });
});

// Add an entry to a library — copies image files from source into the library dir.
// source_lib_id: null = history images dir, or a library id.
app.post("/api/libraries/:id/entries", (req, res) => {
  const libId = parseInt(req.params.id, 10);
  const libs = loadLibraries();
  const lib = libs.find(l => l.id === libId);
  if (!lib) return res.status(404).json({ error: "library not found" });

  const { filename, input_images, source_lib_id, prompt, negative_prompt, workflow_type, loras, timestamp } = req.body;
  const srcLib = source_lib_id ? libs.find(l => l.id === source_lib_id) : null;
  const srcDir = srcLib ? libDir(srcLib) : IMAGES_DIR;
  const dstDir = libDir(lib);
  fs.mkdirSync(dstDir, { recursive: true });

  const safeCopy = (fname) => {
    if (!fname) return false;
    const src = path.join(srcDir, fname);
    const dst = path.join(dstDir, fname);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    return fs.existsSync(dst);
  };

  safeCopy(filename);
  const copiedInputs = (input_images || []).filter(safeCopy);

  lib.entries = lib.entries || [];
  if (filename && lib.entries.some(e => e.filename === filename)) {
    return res.status(409).json({ error: 'duplicate' });
  }

  const entryId = Date.now();
  const entry = { id: entryId, timestamp: timestamp || new Date().toISOString(), filename, prompt, negative_prompt, workflow_type, loras };
  if (copiedInputs.length) entry.input_images = copiedInputs;
  lib.entries.unshift(entry);
  saveLibraries(libs);
  res.json({ ok: true, entryId });
});

app.delete("/api/libraries/:libId/entries/:entryId", (req, res) => {
  const libId = parseInt(req.params.libId, 10);
  const entryId = parseInt(req.params.entryId, 10);
  const libs = loadLibraries();
  const lib = libs.find(l => l.id === libId);
  if (!lib) return res.status(404).json({ error: "library not found" });
  const entry = (lib.entries || []).find(e => e.id === entryId);
  lib.entries = (lib.entries || []).filter(e => e.id !== entryId);
  saveLibraries(libs);
  if (entry) {
    const trashId = generateTrashId();
    const trashEntryDir = path.join(TRASH_DIR, String(trashId));
    const files = [entry.filename, ...(entry.input_images || [])].filter(Boolean);
    moveFilesToTrash(libDir(lib), files, trashEntryDir);
    const trash = loadTrash();
    trash.push({ ...entry, trashId, deletedAt: new Date().toISOString(), source: "library", libId, libName: lib.name, libSlug: lib.slug || String(libId) });
    saveTrash(trash);
  }
  res.json({ ok: true });
});

// Scan a library's directory for image files not already registered as entries,
// read iTXt metadata to populate fields, and find associated input sidecars.
const INPUT_SIDECAR_RE = /-in\d+\.(png|jpg|jpeg|webp)$/i;
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i;

app.post("/api/libraries/:id/import", (req, res) => {
  const libId = parseInt(req.params.id, 10);
  const libs = loadLibraries();
  const lib = libs.find(l => l.id === libId);
  if (!lib) return res.status(404).json({ error: "library not found" });

  const dir = libDir(lib);
  if (!fs.existsSync(dir)) return res.json({ ok: true, imported: 0, skipped: 0 });

  let allFiles;
  try {
    allFiles = fs.readdirSync(dir).filter(f => IMAGE_EXT_RE.test(f));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const mainImages = allFiles.filter(f => !INPUT_SIDECAR_RE.test(f));
  lib.entries = lib.entries || [];
  const existing = new Set(lib.entries.map(e => e.filename));

  let imported = 0;
  let skipped = 0;

  for (const filename of mainImages) {
    if (existing.has(filename)) { skipped++; continue; }

    let prompt = "", workflow_type = "", loras = [];
    if (/\.png$/i.test(filename)) {
      try {
        const meta = readPngItxtChunks(fs.readFileSync(path.join(dir, filename)));
        prompt = meta.prompt || "";
        workflow_type = meta.workflow_type || "";
        loras = meta.loras ? meta.loras.split(",").filter(Boolean) : [];
      } catch {
        // proceed with empty metadata
      }
    }

    // Collect sidecar input files: {base}-in1.png, -in2.png, etc.
    const base = filename.replace(/\.[^.]+$/, "");
    const inputImages = [];
    for (let n = 1; ; n++) {
      const sidecar = allFiles.find(f => f === `${base}-in${n}.png` ||
        f === `${base}-in${n}.jpg` || f === `${base}-in${n}.jpeg` || f === `${base}-in${n}.webp`);
      if (!sidecar) break;
      inputImages.push(sidecar);
    }

    const entry = {
      id: Date.now() + imported,
      timestamp: new Date().toISOString(),
      filename,
      prompt,
      workflow_type,
      loras,
    };
    if (inputImages.length) entry.input_images = inputImages;
    lib.entries.unshift(entry);
    existing.add(filename);
    imported++;
  }

  if (imported > 0) saveLibraries(libs);
  res.json({ ok: true, imported, skipped });
});

// ---------------------------------------------------------------------------
// Workflow builders
// ---------------------------------------------------------------------------

// Custom LoRAs available for both Qwen workflows (toggled from the UI).
// Node IDs 1000–1003 are reserved for these (one slot per entry).
const CUSTOM_LORAS = [
  { id: "Qwen4Play", lora_name: "Qwen4Play-2512.1_e10.safetensors",     strength_model: 1   },
  { id: "nsfw_adv",  lora_name: "qwen-image_nsfw_adv_v1.0.safetensors", strength_model: 0.6 },
  { id: "spanking",  lora_name: "spanking_Qwen-dim64-v1.safetensors",   strength_model: 1   },
  { id: "Korean",    lora_name: "Korean_qwen.safetensors",               strength_model: 0.6 },
];

// Appends enabled LoRA nodes to `workflow`, chained from `startRef`.
// Returns the model ref of the last node in the chain (or startRef if none).
function buildLoraChain(workflow, startRef, selectedLoras = []) {
  let prevRef = startRef;
  CUSTOM_LORAS.forEach((lora, i) => {
    if (selectedLoras.includes(lora.id)) {
      const nodeId = String(1000 + i);
      workflow[nodeId] = {
        class_type: "LoraLoaderModelOnly",
        inputs: { model: prevRef, lora_name: lora.lora_name, strength_model: lora.strength_model },
      };
      prevRef = [nodeId, 0];
    }
  });
  return prevRef;
}

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
  loras = [],
}) {
  const w = width ?? 1328;
  const h = height ?? 1328;
  const workflow = {
    219: {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image" },
    },
    220: {
      class_type: "VAELoader",
      inputs: { vae_name: "qwen_image_vae.safetensors" },
    },
    226: {
      class_type: "UNETLoader",
      inputs: { unet_name: "qwen_image_2512_fp8_e4m3fn.safetensors", weight_dtype: "default" },
    },
    221: {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["226", 0], lora_name: "Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors", strength_model: 1 },
    },
    227: {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt || "", clip: ["219", 0] },
    },
    228: {
      class_type: "CLIPTextEncode",
      inputs: { text: negative_prompt || "低分辨率，低画质，肢体畸形，手指畸形", clip: ["219", 0] },
    },
    232: {
      class_type: "EmptySD3LatentImage",
      inputs: { width: w, height: h, batch_size: 1 },
    },
  };

  // Custom LoRAs chained after Lightning LoRA; ModelSamplingAuraFlow gets final model ref
  const finalModelRef = buildLoraChain(workflow, ["221", 0], loras);
  workflow[222] = {
    class_type: "ModelSamplingAuraFlow",
    inputs: { model: finalModelRef, shift: 3.1 },
  };
  workflow[230] = {
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
  };
  workflow[231] = { class_type: "VAEDecode", inputs: { samples: ["230", 0], vae: ["220", 0] } };
  workflow[60]  = { class_type: "SaveImage",  inputs: { images: ["231", 0], filename_prefix: "ComfyUI" } };
  return workflow;
}

// Qwen-Image 2511 — image edit with 1–3 reference images
function buildWorkflowQwen2511({ prompt, image_filenames = [], seed, loras = [] }) {
  const fnames = image_filenames.length > 0 ? image_filenames.slice(0, 3) : ["input1.png"];

  const workflow = {
    162: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image" } },
    146: { class_type: "VAELoader",  inputs: { vae_name: "qwen_image_vae.safetensors" } },
    161: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_bf16.safetensors", weight_dtype: "default" } },
  };

  // TextEncodeQwenImageEditPlus takes one scaled image per slot (image1/image2/image3).
  // No "original" needed — the reference workflow confirms only the scaled output is passed.
  const nodePairs = [[83, 500], [501, 502], [503, 504]];
  const condImageInputs = {};

  fnames.forEach((fname, i) => {
    const [loadId, scaleId] = nodePairs[i];
    workflow[loadId]  = { class_type: "LoadImage",             inputs: { image: fname, upload: "image" } };
    workflow[scaleId] = { class_type: "FluxKontextImageScale", inputs: { image: [String(loadId), 0] } };
    condImageInputs[`image${i + 1}`] = [String(scaleId), 0]; // image1, image2, image3
  });

  const firstScaleId = String(nodePairs[0][1]);
  workflow[149] = { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "",           clip: ["162", 0], vae: ["146", 0], ...condImageInputs } };
  workflow[151] = { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: prompt || "", clip: ["162", 0], vae: ["146", 0], ...condImageInputs } };
  workflow[147] = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["149", 0], reference_latents_method: "index_timestep_zero" } };
  workflow[148] = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["151", 0], reference_latents_method: "index_timestep_zero" } };
  workflow[145] = { class_type: "ModelSamplingAuraFlow", inputs: { model: ["161", 0], shift: 3.1 } };
  workflow[152] = { class_type: "CFGNorm",               inputs: { model: ["145", 0], strength: 1 } };
  workflow[153] = { class_type: "LoraLoaderModelOnly",   inputs: { model: ["152", 0], lora_name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", strength_model: 1 } };
  workflow[156] = { class_type: "VAEEncode",             inputs: { pixels: [firstScaleId, 0], vae: ["146", 0] } };
  workflow[158] = { class_type: "VAEDecode",             inputs: { samples: ["169", 0], vae: ["146", 0] } };
  workflow[9]   = { class_type: "SaveImage",             inputs: { images: ["158", 0], filename_prefix: "ComfyUI" } };

  const finalModelRef = buildLoraChain(workflow, ["153", 0], loras);
  workflow[169] = {
    class_type: "KSampler",
    inputs: {
      model: finalModelRef,
      positive: ["148", 0],
      negative: ["147", 0],
      latent_image: ["156", 0],
      seed: seed ?? Math.floor(Math.random() * 2 ** 32),
      steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
    },
  };
  return workflow;
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
    loras = [],
  } = req.body;

  let workflow, input;

  if (workflowType === "qwen2512") {
    workflow = buildWorkflowQwen2512({
      prompt,
      negative_prompt,
      width,
      height,
      seed,
      loras,
    });
    workflow["60"].inputs.filename_prefix = buildFilenamePrefix("qwen2512");
    input = { workflow };
  } else if (workflowType === "qwen2511") {
    const imgs = (Array.isArray(req.body.images) ? req.body.images : []).slice(0, 3);
    const image_filenames = imgs.map((img, i) => img.name || `input${i + 1}.png`);
    workflow = buildWorkflowQwen2511({ prompt, image_filenames, seed, loras });
    workflow["9"].inputs.filename_prefix = buildFilenamePrefix("qwen2511");
    input = {
      workflow,
      images: imgs.map(img => ({ name: img.name, image: img.data })),
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
const HOST = process.env.HOST || "127.0.0.1";
const listenHost = HOST === "IP_ADDR_ANY" ? undefined : HOST;
app.listen(PORT, listenHost, () =>
  console.log(`Server running on http://${listenHost ?? "0.0.0.0"}:${PORT}`),
);
