import { Router, type Request, type Response } from "express";
import multer from "multer";
import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  unlinkSync, readdirSync, rmdirSync,
} from "fs";
import { join, extname, basename } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";

const router: Router = Router();

const PYTHON_ENV = {
  ...process.env,
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  PYTHONPATH: "/home/runner/workspace/.pythonlibs/lib/python3.11/site-packages",
};

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
const BHAGWAT_IMGS_DIR = join(DOWNLOAD_DIR, "bhagwat_imgs");
const BHAGWAT_RENDERED_DIR = join(DOWNLOAD_DIR, "bhagwat_rendered");
const BHAGWAT_TMP_DIR = join(DOWNLOAD_DIR, "bhagwat_tmp");

for (const d of [BHAGWAT_IMGS_DIR, BHAGWAT_RENDERED_DIR, BHAGWAT_TMP_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── Image categories ──────────────────────────────────────────────────────────
export const BHAGWAT_CATEGORIES = [
  { id: "krishna",       label: "Lord Krishna" },
  { id: "radha_krishna", label: "Radha Krishna" },
  { id: "ram",           label: "Lord Ram" },
  { id: "sita_ram",      label: "Sita Ram" },
  { id: "hanuman",       label: "Lord Hanuman" },
  { id: "bhagwat",       label: "Bhagwat / Scripture" },
  { id: "bhajan",        label: "Bhajan / Aarti" },
  { id: "general",       label: "General Devotional" },
];

export interface ImageMeta {
  id: string;
  name: string;
  category: string;
  ext: string;
}

function imagePath(meta: ImageMeta) { return join(BHAGWAT_IMGS_DIR, `${meta.id}${meta.ext}`); }
function metaPath(id: string) { return join(BHAGWAT_IMGS_DIR, `${id}.json`); }

function loadImages(): ImageMeta[] {
  if (!existsSync(BHAGWAT_IMGS_DIR)) return [];
  const images: ImageMeta[] = [];
  for (const f of readdirSync(BHAGWAT_IMGS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const meta: ImageMeta = JSON.parse(readFileSync(join(BHAGWAT_IMGS_DIR, f), "utf8"));
      if (existsSync(imagePath(meta))) images.push(meta);
    } catch {}
  }
  return images;
}

function pickImageForCategory(category: string, images: ImageMeta[], usedIndex: number): ImageMeta | null {
  const matching = images.filter(i => i.category === category);
  if (matching.length > 0) return matching[usedIndex % matching.length];
  if (images.length > 0) return images[usedIndex % images.length];
  return null;
}

// ── Multer upload ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, BHAGWAT_IMGS_DIR),
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${randomUUID()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

// ── Image routes ──────────────────────────────────────────────────────────────
router.post("/bhagwat/upload-image", upload.single("image"), (req: Request, res: Response): void => {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
  const category = (req.body.category as string) || "general";
  const ext = extname(req.file.filename);
  const id = basename(req.file.filename, ext);
  const meta: ImageMeta = { id, name: req.file.originalname, category, ext };
  writeFileSync(metaPath(id), JSON.stringify(meta));
  res.json({ ok: true, image: meta });
});

router.get("/bhagwat/images", (_req: Request, res: Response) => {
  res.json({ images: loadImages(), categories: BHAGWAT_CATEGORIES });
});

router.delete("/bhagwat/image/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const images = loadImages();
  const img = images.find(i => i.id === id);
  if (!img) { res.status(404).json({ error: "Not found" }); return; }
  try { unlinkSync(imagePath(img)); } catch {}
  try { unlinkSync(metaPath(id)); } catch {}
  res.json({ ok: true });
});

router.get("/bhagwat/image-file/:filename", (req: Request, res: Response) => {
  const fp = join(BHAGWAT_IMGS_DIR, req.params.filename);
  if (!existsSync(fp)) { res.status(404).json({ error: "Not found" }); return; }
  res.sendFile(fp);
});

// ── Shared utilities (mirrors of youtube.ts helpers) ──────────────────────────
function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    const proc = spawn("python3", ["-m", "yt_dlp", ...args], { env: PYTHON_ENV });
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.stderr.on("data", d => { err += d.toString(); });
    proc.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-800) || `yt-dlp exited ${code}`)));
  });
}

function runYtDlpForSubs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    const proc = spawn("python3", ["-m", "yt_dlp", ...args], {
      env: { ...PYTHON_ENV, YTDLP_NO_LAZY_EXTRACTORS: "1" },
    });
    proc.stdout.on("data", d => { out += d.toString(); });
    proc.stderr.on("data", d => { err += d.toString(); });
    proc.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-300))));
  });
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? httpsGet : httpGet;
    get(url, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
}

interface VttCue { startSec: number; endSec: number; text: string; }
function vttTimeToSec(t: string): number {
  const p = t.split(":");
  if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
  return parseFloat(p[0]) * 60 + parseFloat(p[1]);
}
function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const tl = lines.find(l => l.includes("-->"));
    if (!tl) continue;
    const [startStr, endStr] = tl.split("-->").map(s => s.trim().split(" ")[0]);
    const text = lines.filter(l => !l.includes("-->") && !l.match(/^\d+$/) && l.trim())
      .map(l => l.replace(/<[^>]+>/g, "").trim()).filter(Boolean).join(" ");
    if (text) cues.push({ startSec: vttTimeToSec(startStr), endSec: vttTimeToSec(endStr), text });
  }
  return cues;
}
function cuesToText(cues: VttCue[]): string {
  return cues.map(c => {
    const mm = Math.floor(c.startSec / 60), ss = Math.floor(c.startSec % 60);
    return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${c.text}`;
  }).join("\n");
}
function sampleTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const lines = transcript.split("\n").filter(Boolean);
  const targetLineCount = Math.floor(maxChars / 85);
  if (lines.length <= targetLineCount) return transcript.slice(0, maxChars);
  const step = lines.length / targetLineCount;
  const sampled: string[] = [];
  for (let i = 0; i < targetLineCount; i++) {
    const idx = Math.floor(i * step);
    if (lines[idx]) sampled.push(lines[idx]);
  }
  return `[Note: transcript sampled evenly from all ${lines.length} lines]\n${sampled.join("\n")}`;
}
function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pickBestSubtitleUrl(
  subs: Record<string, any[]>, autoCaps: Record<string, any[]>, videoLang?: string
): string | null {
  const priority = videoLang ? [videoLang, "hi", "en"] : ["hi", "en"];
  for (const pool of [subs, autoCaps]) {
    for (const lang of priority) {
      const list = Object.entries(pool).find(([k]) => k === lang || k.startsWith(lang + "-"))?.[1];
      if (list?.length) {
        const vtt = list.find((f: any) => f.ext === "vtt") ?? list[0];
        if (vtt?.url) return vtt.url;
      }
    }
  }
  return null;
}

// ── Analysis types / job store ────────────────────────────────────────────────
export interface TimelineSegment {
  startSec: number;
  endSec: number;
  category: string;
  isBhajan: boolean;
  imageChangeEvery: number;
  description: string;
}

interface AnalysisJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  result?: { timeline: TimelineSegment[]; videoDuration: number; videoTitle: string };
  error?: string;
  createdAt: number;
}
const analysisJobs = new Map<string, AnalysisJob>();

// ── Analysis routes ───────────────────────────────────────────────────────────
router.post("/bhagwat/analyze", async (req: Request, res: Response) => {
  const { url, mode } = req.body as { url: string; mode?: "smart" | "full" };
  if (!url) { res.status(400).json({ error: "url is required" }); return; }
  const jobId = randomUUID();
  const job: AnalysisJob = { emitter: new EventEmitter(), status: "pending", createdAt: Date.now() };
  analysisJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatAnalysis(jobId, job, url, mode ?? "full").catch(() => {});
});

router.get("/bhagwat/analyze-status/:jobId", (req: Request, res: Response) => {
  const job = analysisJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (job.status === "done") { send("done", job.result!); res.end(); return; }
  if (job.status === "error") { send("error", { message: job.error }); res.end(); return; }
  job.emitter.on("step", d => send("step", d));
  job.emitter.on("done", d => { send("done", d); res.end(); });
  job.emitter.on("error", d => { send("error", d); res.end(); });
  req.on("close", () => job.emitter.removeAllListeners());
});

// ── Render types / job store ──────────────────────────────────────────────────
interface RenderJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  outputPath?: string;
  filename?: string;
  error?: string;
  createdAt: number;
}
const renderJobs = new Map<string, RenderJob>();

// ── Render routes ─────────────────────────────────────────────────────────────
router.post("/bhagwat/render", async (req: Request, res: Response) => {
  const { url, timeline } = req.body as { url: string; timeline: TimelineSegment[] };
  if (!url || !Array.isArray(timeline) || timeline.length === 0) {
    res.status(400).json({ error: "url and timeline are required" }); return;
  }
  const jobId = randomUUID();
  const job: RenderJob = { emitter: new EventEmitter(), status: "pending", createdAt: Date.now() };
  renderJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatRender(jobId, job, url, timeline).catch(() => {});
});

router.get("/bhagwat/render-status/:jobId", (req: Request, res: Response) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (job.status === "done") { send("done", { downloadUrl: `/api/bhagwat/download/${req.params.jobId}`, filename: job.filename }); res.end(); return; }
  if (job.status === "error") { send("error", { message: job.error }); res.end(); return; }
  job.emitter.on("progress", d => send("progress", d));
  job.emitter.on("done", d => { send("done", d); res.end(); });
  job.emitter.on("error", d => { send("error", d); res.end(); });
  req.on("close", () => job.emitter.removeAllListeners());
});

router.get("/bhagwat/download/:jobId", (req: Request, res: Response) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job?.outputPath || !existsSync(job.outputPath)) {
    res.status(404).json({ error: "File not ready" }); return;
  }
  res.download(job.outputPath, job.filename ?? "bhagwat_video.mp4");
});

// ── runBhagwatAnalysis ────────────────────────────────────────────────────────
async function runBhagwatAnalysis(
  jobId: string, job: AnalysisJob, url: string, mode: "smart" | "full"
): Promise<void> {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  const step = (s: string, status: "running" | "done" | "warn", message: string) =>
    emit("step", { step: s, status, message });

  job.status = "running";
  const tmpId = randomUUID();
  const subDir = join(BHAGWAT_TMP_DIR, `subs_${tmpId}`);

  try {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured on the server");

    // Step 1: Metadata
    step("metadata", "running", "Fetching video info…");
    let videoDuration = 0, videoTitle = "", videoDescription = "", transcript = "";
    let metaSubtitleUrl: string | null = null;

    try {
      const metaJson = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
      const meta = JSON.parse(metaJson);
      videoDuration = meta.duration ?? 0;
      videoTitle = meta.title ?? "";
      videoDescription = (meta.description ?? "").slice(0, 800);
      const subs: Record<string, any[]> = meta.subtitles ?? {};
      const autoCaps: Record<string, any[]> = meta.automatic_captions ?? {};
      const videoLang: string | undefined = meta.language ?? meta.original_language;
      metaSubtitleUrl = pickBestSubtitleUrl(subs, autoCaps, videoLang);
      if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
        transcript = meta.chapters.map((c: any) =>
          `[${formatTime(c.start_time)}–${formatTime(c.end_time ?? c.start_time + 60)}] Chapter: ${c.title}`
        ).join("\n");
      }
      step("metadata", "done", `"${videoTitle.slice(0, 55)}${videoTitle.length > 55 ? "…" : ""}" · ${formatTime(videoDuration)}`);
    } catch {
      step("metadata", "warn", "Could not load full metadata — continuing…");
    }

    // Step 2: Transcript
    if (!transcript) {
      step("transcript", "running", "Downloading transcript…");
      let vttContent: string | null = null;
      if (metaSubtitleUrl) {
        try {
          const raw = await fetchUrl(metaSubtitleUrl);
          if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
        } catch {}
      }
      if (!vttContent) {
        try {
          mkdirSync(subDir, { recursive: true });
          const subBase = join(subDir, "sub");
          await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-lang", "hi.*,en.*", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, url]).catch(() => {});
          if (!readdirSync(subDir).some(f => f.endsWith(".vtt"))) {
            await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, url]).catch(() => {});
          }
          const files = readdirSync(subDir);
          const vttFile = files.map(f => join(subDir, f)).find(f => f.endsWith(".vtt"));
          if (vttFile) vttContent = readFileSync(vttFile, "utf8");
          for (const f of files) try { unlinkSync(join(subDir, f)); } catch {}
          try { rmdirSync(subDir); } catch {}
        } catch {}
      }
      if (vttContent) {
        const cues = parseVtt(vttContent);
        const deduped: VttCue[] = [];
        for (const cue of cues) {
          if (!deduped.length || deduped[deduped.length - 1].text !== cue.text) deduped.push(cue);
        }
        transcript = cuesToText(deduped);
        step("transcript", "done", `${deduped.length} transcript lines loaded`);
      } else {
        step("transcript", "warn", "No transcript — AI will work from title & description");
      }
    } else {
      step("transcript", "done", `${transcript.split("\n").length} chapter markers loaded`);
    }

    // Step 3: AI timeline
    step("ai", "running", mode === "full"
      ? "AI is mapping the full video to devotional images…"
      : "AI is identifying the best moments for image placement…");

    const images = loadImages();
    const categoryCounts = BHAGWAT_CATEGORIES.map(c => {
      const count = images.filter(i => i.category === c.id).length;
      return `- ${c.label} (id: "${c.id}"): ${count} image${count !== 1 ? "s" : ""} uploaded`;
    }).join("\n");

    const transcriptForAI = transcript.length > 50
      ? sampleTranscript(transcript, 400000)
      : "";
    const transcriptBlock = transcriptForAI
      ? `\nTranscript (Hindi/English/mixed):\n${transcriptForAI}`
      : "\n[No transcript available — use title and description to infer content structure]";

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: `You are an expert devotional video editor specializing in Bhagwat Katha, Hindu stories (Leelas), and devotional content. You are fully fluent in Hindi and English.

Your task: Analyze the transcript and create an image placement timeline for this devotional video.

AVAILABLE IMAGE CATEGORIES (use ONLY these exact category ids):
${categoryCounts}

CONTENT DETECTION RULES:
1. KATHA / NARRATION (story telling, leela description): images change every 6-12 seconds. Choose a deity category that matches the story being told. If narrating Dhruv Bhakt story → use "krishna" or "bhagwat". If Ram katha → use "ram" or "sita_ram".
2. BHAJAN SECTIONS (when the speaker sings, or a devotional song/kirtan plays — look for repeated naam-jap phrases, "Hare Krishna", "Jai Shri Ram", "Govinda" etc.): images change every 20-35 seconds. Use "bhajan", "radha_krishna", "sita_ram", or matching deity. These sections MUST have LONGER image durations — this creates a peaceful meditative feel.
3. SHLOKA / VERSE RECITATION (Sanskrit shlokas or verses): images change every 10-16 seconds. Prefer "bhagwat" or "krishna".
4. INTRODUCTION / CLOSING / TRANSITIONS: images change every 8-12 seconds. Use "bhagwat" or "general".

For bhajan detection in Hindi transcripts: look for repeated lines, devotional song lyrics (doha/chaupai), or musical/rhythmic patterns. These must have imageChangeEvery ≥ 20.

${mode === "full"
  ? `FULL COVERAGE MODE: Your timeline MUST cover every second from 0s to ${videoDuration}s with NO gaps. Segments must be contiguous. First segment must start at 0. Last segment must end at exactly ${videoDuration}.`
  : `SMART MODE: Cover the most engaging, story-rich, and devotionally significant sections. You do not need to cover every second.`
}

CRITICAL: Respond with ONLY a valid JSON array — no markdown fences, no extra text:
[{"startSec": 0, "endSec": 180, "category": "bhagwat", "isBhajan": false, "imageChangeEvery": 10, "description": "Brief English description of this section"}]`,
    });

    const userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}\n` : ""}${transcriptBlock}

Create a complete image timeline for this devotional video. Identify every katha, bhajan, and shloka section. For bhajans, use imageChangeEvery of 20-35. Cover the ${mode === "full" ? "FULL video with no gaps" : "best moments"}.`;

    const result = await model.generateContent(userContent);
    const raw = result.response.text().trim();

    // Parse AI response
    let timeline: TimelineSegment[] = [];
    try {
      let cleaned = raw.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        timeline = arr.filter((s: any) => s && typeof s.startSec === "number" && typeof s.endSec === "number" && s.endSec > s.startSec)
          .map((s: any): TimelineSegment => ({
            startSec: Math.max(0, Math.round(s.startSec)),
            endSec: Math.min(videoDuration || 999999, Math.round(s.endSec)),
            category: BHAGWAT_CATEGORIES.find(c => c.id === s.category) ? s.category : "general",
            isBhajan: s.isBhajan === true,
            imageChangeEvery: Math.max(3, Math.min(60, Math.round(s.imageChangeEvery ?? 8))),
            description: s.description ?? "",
          }));
      }
    } catch {
      throw new Error("AI returned invalid JSON — please try again");
    }

    if (timeline.length === 0) throw new Error("AI returned an empty timeline — please try again");

    // Normalize: sort + close gaps for full mode
    timeline.sort((a, b) => a.startSec - b.startSec);
    if (mode === "full" && videoDuration > 0) {
      // Fill gap at start
      if (timeline[0].startSec > 0) {
        timeline.unshift({ startSec: 0, endSec: timeline[0].startSec, category: "bhagwat", isBhajan: false, imageChangeEvery: 8, description: "Opening" });
      }
      // Fill gaps between segments
      const filled: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = filled[filled.length - 1];
        if (timeline[i].startSec > prev.endSec) {
          filled.push({ startSec: prev.endSec, endSec: timeline[i].startSec, category: "general", isBhajan: false, imageChangeEvery: 8, description: "Continuation" });
        }
        filled.push(timeline[i]);
      }
      // Extend last to cover full duration
      filled[filled.length - 1].endSec = videoDuration;
      timeline = filled;
    }

    step("ai", "done", `Timeline ready — ${timeline.length} segments`);

    const resultData = { timeline, videoDuration, videoTitle };
    job.status = "done";
    job.result = resultData;
    emit("done", resultData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    job.status = "error";
    job.error = message;
    emit("error", { message });
    try { if (existsSync(subDir)) { for (const f of readdirSync(subDir)) try { unlinkSync(join(subDir, f)); } catch {} } } catch {}
  }
}

// ── runBhagwatRender ──────────────────────────────────────────────────────────
async function runBhagwatRender(
  jobId: string, job: RenderJob, url: string, timeline: TimelineSegment[]
): Promise<void> {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  job.status = "running";

  const tmpId = randomUUID();
  const tmpBase = join(BHAGWAT_TMP_DIR, tmpId);
  const concatPath = `${tmpBase}_concat.txt`;
  const audioPath = `${tmpBase}_audio`;
  const outputPath = join(BHAGWAT_RENDERED_DIR, `${jobId}.mp4`);

  try {
    emit("progress", { phase: "download", percent: 0, message: "Downloading audio from YouTube…" });

    // Download audio
    const audioOut = await runYtDlp([
      "-f", "bestaudio",
      "--no-playlist",
      "--no-warnings",
      "-o", `${audioPath}.%(ext)s`,
      url,
    ]);

    // Find downloaded audio file
    const tmpDir2 = BHAGWAT_TMP_DIR;
    const audioFiles = readdirSync(tmpDir2).filter(f => f.startsWith(basename(audioPath)));
    const audioFile = audioFiles.length > 0 ? join(tmpDir2, audioFiles[0]) : null;
    if (!audioFile || !existsSync(audioFile)) throw new Error("Failed to download audio from YouTube");

    emit("progress", { phase: "download", percent: 20, message: "Audio downloaded. Building image slideshow…" });

    // Load image library
    const images = loadImages();
    if (images.length === 0) throw new Error("No images in library. Please upload at least one image.");

    // Build concat list
    const concatLines: string[] = [];
    let imgIndexByCategory: Record<string, number> = {};

    for (const segment of timeline) {
      const segDuration = segment.endSec - segment.startSec;
      if (segDuration <= 0) continue;
      let elapsed = 0;

      while (elapsed < segDuration - 0.1) {
        const thisDuration = Math.min(segment.imageChangeEvery, segDuration - elapsed);
        const catIdx = imgIndexByCategory[segment.category] ?? 0;
        const img = pickImageForCategory(segment.category, images, catIdx);
        imgIndexByCategory[segment.category] = catIdx + 1;

        if (!img) break;
        const fp = imagePath(img).replace(/'/g, "'\\''");
        concatLines.push(`file '${fp}'`);
        concatLines.push(`duration ${thisDuration.toFixed(3)}`);
        elapsed += thisDuration;
      }
    }

    if (concatLines.length === 0) throw new Error("Could not build image list — check your image library.");

    // FFmpeg concat demuxer quirk: last file needs to appear again without duration
    const lastFileLine = [...concatLines].reverse().find(l => l.startsWith("file"));
    if (lastFileLine) concatLines.push(lastFileLine);

    writeFileSync(concatPath, concatLines.join("\n"));

    emit("progress", { phase: "render", percent: 30, message: "Rendering video with FFmpeg…" });

    const totalDuration = timeline.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
    const videoTitle = `bhagwat_video_${tmpId.slice(0, 6)}`;
    job.filename = `${videoTitle}.mp4`;

    await new Promise<void>((resolve, reject) => {
      const ffArgs = [
        "-f", "concat", "-safe", "0", "-i", concatPath,
        "-i", audioFile,
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        "-y",
        outputPath,
      ];

      const ff = spawn("ffmpeg", ffArgs);
      let stderr = "";
      ff.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        // Parse progress: time=HH:MM:SS.ms
        const match = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g);
        if (match) {
          const last = match[match.length - 1];
          const [, h, m, s] = last.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/)!;
          const processedSec = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
          const pct = totalDuration > 0 ? Math.min(95, 30 + Math.round((processedSec / totalDuration) * 65)) : 50;
          emit("progress", { phase: "render", percent: pct, message: `Rendering… ${formatTime(processedSec)} / ${formatTime(totalDuration)}` });
        }
      });
      ff.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg failed (exit ${code}): ${stderr.slice(-500)}`));
      });
    });

    // Cleanup tmp files
    try { unlinkSync(concatPath); } catch {}
    try { unlinkSync(audioFile); } catch {}

    emit("progress", { phase: "done", percent: 100, message: "Video ready for download!" });

    job.status = "done";
    job.outputPath = outputPath;
    emit("done", { downloadUrl: `/api/bhagwat/download/${jobId}`, filename: job.filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    job.status = "error";
    job.error = message;
    emit("error", { message });
    try { unlinkSync(concatPath); } catch {}
  }
}

export default router;
