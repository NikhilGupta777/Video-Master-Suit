import { Router, type Request, type Response } from "express";
import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  unlinkSync, readdirSync, rmdirSync,
} from "fs";
import { join, basename } from "path";
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
const BHAGWAT_RENDERED_DIR = join(DOWNLOAD_DIR, "bhagwat_rendered");
const BHAGWAT_TMP_DIR = join(DOWNLOAD_DIR, "bhagwat_tmp");

for (const d of [BHAGWAT_RENDERED_DIR, BHAGWAT_TMP_DIR]) {
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

// ── AI Image Generation ───────────────────────────────────────────────────────
function buildImagePrompt(category: string, description: string, isBhajan: boolean, index: number): string {
  const variations = [
    "serene golden divine atmosphere",
    "rich vibrant devotional colors, lotus flowers nearby",
    "celestial soft light, sacred temple setting",
  ];
  const variation = variations[index % variations.length];

  const bases: Record<string, string> = {
    krishna:
      "Exquisitely detailed devotional digital painting of Lord Krishna with blue divine skin, peacock feather crown, holding a golden flute, wrapped in yellow pitambara silk, standing in Vrindavan, divine aura glowing",
    radha_krishna:
      "Radha and Krishna together in divine eternal love, golden celestial light, surrounded by lotus flowers and peacocks, traditional devotional Indian art style",
    ram:
      "Lord Ram in royal warrior attire, bow and arrow, divine golden crown, serene powerful expression, celestial blue sky background, devotional art",
    sita_ram:
      "Sita and Ram together as divine couple, Ram in royal attire with bow, Sita in golden saree, hands joined, lotus throne, devotional painting",
    hanuman:
      "Lord Hanuman in powerful reverent pose, saffron body, mace in hand, Ram's name on heart, devotional expression, mountain backdrop, divine energy",
    bhagwat:
      "Sacred Shrimad Bhagavatam scripture open on lotus, golden divine light rays, Sanskrit text glowing, spiritual atmosphere, devotional setting",
    bhajan:
      isBhajan
        ? "Devotees in kirtan, hands raised in ecstasy, Lord Krishna's image glowing above, divine golden light, flowers raining from sky, devotional bliss"
        : "Divine lotus flowers floating on sacred water, golden light, spiritual peace, devotional atmosphere",
    general:
      "Beautiful Hindu devotional art, divine golden light from the heavens, sacred atmosphere, rich warm spiritual colors, lotus motifs",
  };

  const base = bases[category] ?? bases["general"];
  const context = description
    ? `. The scene depicts: ${description}`
    : "";

  return `${base}${context}. Style: ${variation}. High quality, photorealistic devotional painting, no text, no watermarks, no borders. Aspect ratio 16:9, wide format suitable for video overlay.`;
}

async function generateImage(
  genAI: GoogleGenerativeAI,
  prompt: string,
  outputPath: string
): Promise<void> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-preview-image-generation",
    // @ts-ignore – generationConfig supports responseModalities
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  const result = await model.generateContent(prompt);
  const candidate = result.response.candidates?.[0];
  if (!candidate) throw new Error("Gemini returned no candidate");

  for (const part of candidate.content.parts) {
    if ((part as any).inlineData?.data) {
      const imageData = (part as any).inlineData.data as string;
      const imageBuffer = Buffer.from(imageData, "base64");
      writeFileSync(outputPath, imageBuffer);
      return;
    }
  }
  throw new Error("Gemini returned no image data in response");
}

// Generate a pool of images for a category, with concurrency limit
async function generateImagePool(
  genAI: GoogleGenerativeAI,
  segments: TimelineSegment[],
  tmpBase: string,
  onProgress: (msg: string) => void
): Promise<Map<string, string[]>> {
  // Group segments by category — collect up to 3 unique descriptions per category
  const categoryGroups = new Map<string, { category: string; isBhajan: boolean; descriptions: string[] }>();

  for (const seg of segments) {
    const key = `${seg.category}_${seg.isBhajan ? "bhajan" : "katha"}`;
    if (!categoryGroups.has(key)) {
      categoryGroups.set(key, { category: seg.category, isBhajan: seg.isBhajan, descriptions: [] });
    }
    const group = categoryGroups.get(key)!;
    const desc = seg.description?.trim();
    if (desc && !group.descriptions.includes(desc) && group.descriptions.length < 3) {
      group.descriptions.push(desc);
    }
    // Ensure at least 3 images per group
    while (group.descriptions.length < 3) {
      group.descriptions.push("");
    }
  }

  const imageMap = new Map<string, string[]>();
  const tasks: Array<{ key: string; idx: number; prompt: string; path: string }> = [];

  for (const [key, group] of categoryGroups) {
    const paths: string[] = [];
    for (let i = 0; i < group.descriptions.length; i++) {
      const imgPath = join(tmpBase, `${key}_${i}.png`);
      const prompt = buildImagePrompt(group.category, group.descriptions[i], group.isBhajan, i);
      tasks.push({ key, idx: i, prompt, path: imgPath });
      paths.push(imgPath);
    }
    imageMap.set(key, paths);
  }

  // Generate with concurrency limit of 3
  const CONCURRENCY = 3;
  let completed = 0;
  const total = tasks.length;

  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (task) => {
        try {
          onProgress(`Generating image ${completed + 1}/${total}: ${task.key.replace("_", " — ")}…`);
          await generateImage(genAI, task.prompt, task.path);
        } catch (e) {
          // If generation fails, fall back to a simpler prompt
          const fallbackPrompt = `Beautiful devotional Hindu art, ${task.key.replace("_bhajan", " bhajan").replace("_katha", " katha")}, golden light, spiritual atmosphere. Wide 16:9 format.`;
          await generateImage(genAI, fallbackPrompt, task.path).catch(() => {});
        }
        completed++;
      })
    );
  }

  return imageMap;
}

// ── Shared utilities ───────────────────────────────────────────────────────────
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

// ── Timeline types ────────────────────────────────────────────────────────────
export interface TimelineSegment {
  startSec: number;
  endSec: number;
  category: string;
  isBhajan: boolean;
  imageChangeEvery: number;
  description: string;
}

// ── Analysis job store ────────────────────────────────────────────────────────
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

// ── Render job store ──────────────────────────────────────────────────────────
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

AVAILABLE CATEGORY IDs (use ONLY these exact values):
- "krishna"       → Lord Krishna narration, Bhagavatam stories, Govinda leelas
- "radha_krishna" → Radha Krishna love stories, Vrindavan leelas
- "ram"           → Ram katha, Ramayana stories, Ram's leelas
- "sita_ram"      → Sita Ram together, their divine relationship
- "hanuman"       → Hanuman katha, Hanuman's devotion to Ram
- "bhagwat"       → Bhagavad Gita, scripture recitation, shlokas, opening/closing
- "bhajan"        → Bhajan singing, kirtan, naam-jap, devotional songs
- "general"       → Any other devotional content

CONTENT DETECTION RULES:
1. KATHA / NARRATION (storytelling, leela descriptions): imageChangeEvery = 6–12 seconds. Choose the deity category matching the story. Dhruv Bhakt / Prahladh ji → "krishna" or "bhagwat". Ram katha → "ram" or "sita_ram".
2. BHAJAN / KIRTAN / NAAM-JAP (repeated devotional phrases, song lyrics, musical patterns): imageChangeEvery = 20–35 seconds. Use "bhajan", "radha_krishna", "sita_ram", or matching deity. MUST be ≥ 20 seconds — creates meditative peace.
3. SHLOKA / VERSE RECITATION (Sanskrit verses): imageChangeEvery = 10–16 seconds. Prefer "bhagwat" or "krishna".
4. INTRODUCTION / CLOSING / TRANSITIONS: imageChangeEvery = 8–12 seconds. Use "bhagwat" or "general".

Bhajan detection in Hindi: look for repeated lines, song lyrics (doha/chaupai), "Hare Krishna", "Jai Shri Ram", "Govinda", "Siya Ram" naam-jap patterns.

${mode === "full"
  ? `FULL COVERAGE MODE: Timeline MUST cover every second from 0 to ${videoDuration}s with NO gaps. First segment starts at 0, last ends at exactly ${videoDuration}.`
  : `SMART MODE: Cover the most engaging, story-rich, devotionally significant sections. No need to cover every second.`
}

CRITICAL: Respond with ONLY a valid JSON array — no markdown fences, no extra text. The "description" field must be a short English phrase describing exactly what is happening in this segment (e.g., "Dhruv Bhakt meditating in the forest", "Kirtan of Hare Krishna", "Opening prayers"):
[{"startSec": 0, "endSec": 180, "category": "bhagwat", "isBhajan": false, "imageChangeEvery": 10, "description": "Opening prayer and introduction"}]`,
    });

    const userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}\n` : ""}${transcriptBlock}

Create a complete image timeline. Identify every katha, bhajan, and shloka section. For bhajans use imageChangeEvery 20–35. Descriptions must be specific to the content being narrated so AI can generate accurate images. Cover the ${mode === "full" ? "FULL video with no gaps" : "best moments"}.`;

    const result = await model.generateContent(userContent);
    const raw = result.response.text().trim();

    let timeline: TimelineSegment[] = [];
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        timeline = arr
          .filter((s: any) => s && typeof s.startSec === "number" && typeof s.endSec === "number" && s.endSec > s.startSec)
          .map((s: any): TimelineSegment => ({
            startSec: Math.max(0, Math.round(s.startSec)),
            endSec: Math.min(videoDuration || 999999, Math.round(s.endSec)),
            category: BHAGWAT_CATEGORIES.find(c => c.id === s.category) ? s.category : "general",
            isBhajan: s.isBhajan === true,
            imageChangeEvery: Math.max(3, Math.min(60, Math.round(s.imageChangeEvery ?? 8))),
            description: (s.description ?? "").slice(0, 200),
          }));
      }
    } catch {
      throw new Error("AI returned invalid JSON — please try again");
    }

    if (timeline.length === 0) throw new Error("AI returned an empty timeline — please try again");

    // Normalize: sort + close gaps for full mode
    timeline.sort((a, b) => a.startSec - b.startSec);
    if (mode === "full" && videoDuration > 0) {
      if (timeline[0].startSec > 0) {
        timeline.unshift({ startSec: 0, endSec: timeline[0].startSec, category: "bhagwat", isBhajan: false, imageChangeEvery: 8, description: "Opening" });
      }
      const filled: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = filled[filled.length - 1];
        if (timeline[i].startSec > prev.endSec) {
          filled.push({ startSec: prev.endSec, endSec: timeline[i].startSec, category: "general", isBhajan: false, imageChangeEvery: 8, description: "Continuation" });
        }
        filled.push(timeline[i]);
      }
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
    try {
      if (existsSync(subDir)) {
        for (const f of readdirSync(subDir)) try { unlinkSync(join(subDir, f)); } catch {}
        rmdirSync(subDir);
      }
    } catch {}
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
  const imgDir = join(BHAGWAT_TMP_DIR, `imgs_${tmpId}`);
  mkdirSync(imgDir, { recursive: true });

  try {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured on the server");

    // Step 1: Download audio
    emit("progress", { phase: "download", percent: 5, message: "Downloading audio from YouTube…" });
    await runYtDlp(["-f", "bestaudio", "--no-playlist", "--no-warnings", "-o", `${audioPath}.%(ext)s`, url]);

    const audioFiles = readdirSync(BHAGWAT_TMP_DIR).filter(f => f.startsWith(basename(audioPath)));
    const audioFile = audioFiles.length > 0 ? join(BHAGWAT_TMP_DIR, audioFiles[0]) : null;
    if (!audioFile || !existsSync(audioFile)) throw new Error("Failed to download audio from YouTube");

    emit("progress", { phase: "images", percent: 10, message: "AI is generating devotional images…" });

    // Step 2: Generate images with Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    let generatedCount = 0;

    const imageMap = await generateImagePool(
      genAI,
      timeline,
      imgDir,
      (msg) => {
        generatedCount++;
        const pct = 10 + Math.min(50, Math.round((generatedCount / (timeline.length * 0.5)) * 40));
        emit("progress", { phase: "images", percent: pct, message: msg });
      }
    );

    // Verify at least some images were generated
    const allGenerated = [...imageMap.values()].flat().filter(p => existsSync(p));
    if (allGenerated.length === 0) throw new Error("AI image generation failed — no images were created");

    emit("progress", { phase: "images", percent: 60, message: `${allGenerated.length} images generated. Building video…` });

    // Step 3: Build ffmpeg concat list
    const concatLines: string[] = [];
    const usedIndexByKey = new Map<string, number>();

    for (const segment of timeline) {
      const segDuration = segment.endSec - segment.startSec;
      if (segDuration <= 0) continue;
      const key = `${segment.category}_${segment.isBhajan ? "bhajan" : "katha"}`;
      const pool = (imageMap.get(key) ?? allGenerated).filter(p => existsSync(p));
      if (pool.length === 0) continue;

      let elapsed = 0;
      while (elapsed < segDuration - 0.1) {
        const thisDuration = Math.min(segment.imageChangeEvery, segDuration - elapsed);
        const idx = usedIndexByKey.get(key) ?? 0;
        const imgPath = pool[idx % pool.length].replace(/'/g, "'\\''");
        concatLines.push(`file '${imgPath}'`);
        concatLines.push(`duration ${thisDuration.toFixed(3)}`);
        usedIndexByKey.set(key, idx + 1);
        elapsed += thisDuration;
      }
    }

    if (concatLines.length === 0) throw new Error("Could not build image list from generated images");

    // FFmpeg concat quirk: repeat last file without duration
    const lastFileLine = [...concatLines].reverse().find(l => l.startsWith("file"));
    if (lastFileLine) concatLines.push(lastFileLine);

    writeFileSync(concatPath, concatLines.join("\n"));

    emit("progress", { phase: "render", percent: 65, message: "Rendering video with FFmpeg…" });

    const totalDuration = timeline.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
    const videoTitle = `bhagwat_video_${tmpId.slice(0, 6)}`;
    job.filename = `${videoTitle}.mp4`;

    await new Promise<void>((resolve, reject) => {
      const ffArgs = [
        "-f", "concat", "-safe", "0", "-i", concatPath,
        "-i", audioFile,
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        "-y",
        outputPath,
      ];

      const ff = spawn("ffmpeg", ffArgs);
      let stderr = "";
      ff.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        const match = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g);
        if (match) {
          const last = match[match.length - 1];
          const [, h, m, s] = last.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/)!;
          const processedSec = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
          const pct = totalDuration > 0 ? Math.min(98, 65 + Math.round((processedSec / totalDuration) * 33)) : 80;
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
    try {
      for (const f of readdirSync(imgDir)) try { unlinkSync(join(imgDir, f)); } catch {}
      rmdirSync(imgDir);
    } catch {}

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
    try {
      for (const f of readdirSync(imgDir)) try { unlinkSync(join(imgDir, f)); } catch {}
      rmdirSync(imgDir);
    } catch {}
  }
}

export default router;
