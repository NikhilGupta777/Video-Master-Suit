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

// ── Timeline segment — AI decides everything per segment ──────────────────────
export interface TimelineSegment {
  startSec: number;
  endSec: number;
  isBhajan: boolean;
  imageChangeEvery: number; // seconds between image changes within this segment — AI decides
  description: string;      // brief human-readable label shown in UI
  imagePrompt: string;      // specific Gemini image-gen prompt for this exact story moment
}

// ── Gemini image generation ───────────────────────────────────────────────────
async function generateImage(
  genAI: GoogleGenerativeAI,
  prompt: string,
  outputPath: string
): Promise<void> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-preview-image-generation",
    // @ts-ignore
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  const fullPrompt = `${prompt}

Style requirements: high-quality devotional digital painting, warm spiritual atmosphere, rich colors, no text, no watermarks, no borders, wide 16:9 aspect ratio suitable for video overlay.`;

  const result = await model.generateContent(fullPrompt);
  const candidate = result.response.candidates?.[0];
  if (!candidate) throw new Error("Gemini returned no candidate");

  for (const part of candidate.content.parts) {
    if ((part as any).inlineData?.data) {
      writeFileSync(outputPath, Buffer.from((part as any).inlineData.data, "base64"));
      return;
    }
  }
  throw new Error("Gemini returned no image data");
}

// Generate images for all segments — 2 per katha segment, 1 per bhajan segment
async function generateAllSegmentImages(
  genAI: GoogleGenerativeAI,
  segments: TimelineSegment[],
  imgDir: string,
  onProgress: (done: number, total: number, msg: string) => void
): Promise<string[][]> {
  // Build task list: each task is one image generation
  interface Task { segIdx: number; imgIdx: number; prompt: string; path: string; }
  const tasks: Task[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Bhajan: 1 image (held long, no variety needed)
    // Katha:  2 images (cycles to give visual variety while telling same story moment)
    const count = seg.isBhajan ? 1 : 2;
    for (let j = 0; j < count; j++) {
      tasks.push({
        segIdx: i,
        imgIdx: j,
        prompt: seg.imagePrompt,
        path: join(imgDir, `seg_${i}_${j}.png`),
      });
    }
  }

  // Result: imagePaths[segIdx] = array of file paths
  const imagePaths: string[][] = segments.map(() => []);
  let done = 0;
  const total = tasks.length;

  // Process with concurrency = 3
  const CONCURRENCY = 3;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (task) => {
        try {
          await generateImage(genAI, task.prompt, task.path);
          imagePaths[task.segIdx].push(task.path);
        } catch {
          // Retry with a simpler fallback prompt
          const fallback = `${task.prompt}. Devotional Indian painting style.`;
          try {
            await generateImage(genAI, fallback, task.path);
            imagePaths[task.segIdx].push(task.path);
          } catch {
            // Skip this image slot — will use neighbor's image
          }
        }
        done++;
        onProgress(done, total, segments[task.segIdx].description);
      })
    );
  }

  // Fill any empty pools with a neighbor's images so concat never has gaps
  for (let i = 0; i < imagePaths.length; i++) {
    if (imagePaths[i].length === 0) {
      // Find nearest segment with images
      for (let d = 1; d < imagePaths.length; d++) {
        if (i - d >= 0 && imagePaths[i - d].length > 0) { imagePaths[i] = imagePaths[i - d]; break; }
        if (i + d < imagePaths.length && imagePaths[i + d].length > 0) { imagePaths[i] = imagePaths[i + d]; break; }
      }
    }
  }

  return imagePaths;
}

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
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
      res.on("data", c => { body += c; });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── VTT / transcript helpers ──────────────────────────────────────────────────
interface VttCue { startSec: number; endSec: number; text: string; }
function vttTimeToSec(t: string): number {
  const p = t.split(":");
  return p.length === 3
    ? parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2])
    : parseFloat(p[0]) * 60 + parseFloat(p[1]);
}
function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const tl = lines.find(l => l.includes("-->"));
    if (!tl) continue;
    const [startStr] = tl.split("-->").map(s => s.trim().split(" ")[0]);
    const endStr = tl.split("-->")[1].trim().split(" ")[0];
    const text = lines
      .filter(l => !l.includes("-->") && !l.match(/^\d+$/) && l.trim())
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
  const targetCount = Math.floor(maxChars / 85);
  if (lines.length <= targetCount) return transcript.slice(0, maxChars);
  const step = lines.length / targetCount;
  const out: string[] = [];
  for (let i = 0; i < targetCount; i++) {
    const l = lines[Math.floor(i * step)];
    if (l) out.push(l);
  }
  return `[Transcript sampled from ${lines.length} total lines]\n${out.join("\n")}`;
}
function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
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

// ── Analysis job store ────────────────────────────────────────────────────────
interface AnalysisJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  result?: { timeline: TimelineSegment[]; videoDuration: number; videoTitle: string };
  error?: string;
  createdAt: number;
}
const analysisJobs = new Map<string, AnalysisJob>();

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
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

    // ── Step 1: Metadata ──────────────────────────────────────────────────────
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
      metaSubtitleUrl = pickBestSubtitleUrl(subs, autoCaps, meta.language ?? meta.original_language);
      if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
        transcript = meta.chapters.map((c: any) =>
          `[${formatTime(c.start_time)}–${formatTime(c.end_time ?? c.start_time + 60)}] ${c.title}`
        ).join("\n");
      }
      step("metadata", "done", `"${videoTitle.slice(0, 55)}${videoTitle.length > 55 ? "…" : ""}" · ${formatTime(videoDuration)}`);
    } catch {
      step("metadata", "warn", "Could not load full metadata — continuing…");
    }

    // ── Step 2: Transcript ────────────────────────────────────────────────────
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

    // ── Step 3: AI timeline ───────────────────────────────────────────────────
    step("ai", "running", "AI editor is reading the katha and planning image placements…");

    const transcriptBlock = transcript.length > 50
      ? `\nTranscript (Hindi/English):\n${sampleTranscript(transcript, 400000)}`
      : "\n[No transcript — use video title and description to infer content]";

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: `You are a professional devotional video editor with deep knowledge of Hindu scriptures, Bhagwat Katha, Ramayan, Mahabharat, and all Hindu devotional stories and bhajans. You are fully fluent in Hindi and English.

Your task: Watch this video (via transcript) exactly like an expert editor sitting at a timeline, and decide the best image to place at every moment of the story. You must think like an editor: "what image best represents what the speaker is saying RIGHT NOW?"

WHAT YOU ARE EDITING:
- Bhagwat Katha / Ram Katha / any Hindu devotional katha
- The speaker narrates stories, recites shlokas, and sometimes sings or plays bhajans
- Your job: plan a sequence of images that visually brings the narration to life

HOW TO THINK ABOUT EACH SEGMENT:
1. STORY NARRATION (katha): Break into logical story beats. Each beat gets ONE specific image prompt that captures that exact moment of the story. Imagine you are choosing from millions of devotional paintings which one would fit this narration best. Be specific — not "Lord Krishna" but "Lord Krishna as a young boy stealing butter from the pot, mother Yashoda watching, cozy village home in Vrindavan, 16th century devotional painting style". Images should change every 8–15 seconds for katha narration.

2. BHAJAN / KIRTAN (when speaker sings a devotional song or plays music): Detect this by repeated devotional phrases, "Hare Krishna Hare Ram", "Jai Shri Ram", "Govind Bolo", song lyrics, musical patterns. For bhajans: use calm meditative devotional imagery — NOT the story scenes, but peaceful deity imagery (Krishna with flute, Ram holding bow, etc.). Change images every 25–40 seconds (bhajans have a slow, meditative rhythm). Mark isBhajan: true.

3. SHLOKA RECITATION: Sanskrit verses being recited. Use sacred imagery — open scripture, deity, temple. Change every 12–18 seconds.

4. OPENING / CLOSING / TRANSITIONS: Use auspicious imagery. Change every 10–15 seconds.

THE STORY MUST FLOW: If narrating Dhruv Bhakt's story, your segments should visually tell the WHOLE story in sequence:
- Dhruv rejected by stepmother → forest with young boy walking → Narada Muni meeting Dhruv → Dhruv meditating → Lord Vishnu's divine appearance → Dhruv's elevation to Dhruv Loka
Each scene gets its OWN carefully crafted image prompt.

IMAGE PROMPT RULES:
- Write in English, even if the transcript is Hindi
- Be specific and vivid: scene, characters, their appearance, setting, lighting, mood
- Include style: "traditional devotional Indian painting", "divine golden light", "16th century miniature painting style", etc.
- Do NOT include: text, watermarks, logos, borders, modern photography
- Bhajan prompts: peaceful, divine, deity-focused, not a story scene

${mode === "full"
  ? `FULL COVERAGE: Every second must be covered. No gaps. Start at 0, end at exactly ${videoDuration}. Segments must be contiguous.`
  : `SMART PLACEMENT: Cover only the most visually rich moments — key story beats, bhajans, and climactic scenes. Gaps are allowed.`}

RESPOND with ONLY a valid JSON array, no markdown fences:
[
  {
    "startSec": 0,
    "endSec": 120,
    "isBhajan": false,
    "imageChangeEvery": 12,
    "description": "Opening — speaker introduces the katha",
    "imagePrompt": "Ancient temple at sunrise, golden light rays, priests performing morning aarti, smoke of incense, bells ringing atmosphere, traditional devotional Indian painting style"
  }
]`,
    });

    const userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}` : ""}
${transcriptBlock}

Plan the full image timeline for this video. Write specific image prompts for each story beat. For bhajans, write calm devotional imagery with longer durations. ${mode === "full" ? "Cover every second from 0 to " + videoDuration + "s." : "Cover the key moments."}`;

    const result = await model.generateContent(userContent);
    const raw = result.response.text().trim();

    let timeline: TimelineSegment[] = [];
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        timeline = arr
          .filter((s: any) => s && typeof s.startSec === "number" && typeof s.endSec === "number" && s.endSec > s.startSec && s.imagePrompt)
          .map((s: any): TimelineSegment => ({
            startSec: Math.max(0, Math.round(s.startSec)),
            endSec: Math.min(videoDuration || 999999, Math.round(s.endSec)),
            isBhajan: s.isBhajan === true,
            imageChangeEvery: Math.max(5, Math.min(60, Math.round(s.imageChangeEvery ?? 12))),
            description: (s.description ?? "").slice(0, 150),
            imagePrompt: (s.imagePrompt ?? "").slice(0, 600),
          }));
      }
    } catch {
      throw new Error("AI returned invalid JSON — please try again");
    }

    if (timeline.length === 0) throw new Error("AI returned an empty timeline — please try again");

    // Sort and (for full mode) ensure coverage with no gaps
    timeline.sort((a, b) => a.startSec - b.startSec);
    if (mode === "full" && videoDuration > 0) {
      if (timeline[0].startSec > 0) {
        timeline.unshift({
          startSec: 0, endSec: timeline[0].startSec,
          isBhajan: false, imageChangeEvery: 10,
          description: "Opening",
          imagePrompt: "Auspicious opening scene — ancient temple entrance, golden morning light, flowers and oil lamps, devotional atmosphere, traditional Indian painting style",
        });
      }
      const filled: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = filled[filled.length - 1];
        if (timeline[i].startSec > prev.endSec) {
          filled.push({
            startSec: prev.endSec, endSec: timeline[i].startSec,
            isBhajan: false, imageChangeEvery: 10,
            description: "Continuation",
            imagePrompt: prev.imagePrompt, // reuse previous scene image
          });
        }
        filled.push(timeline[i]);
      }
      filled[filled.length - 1].endSec = videoDuration;
      timeline = filled;
    }

    step("ai", "done", `${timeline.length} segments planned · ${timeline.filter(s => s.isBhajan).length} bhajan sections`);

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
  const concatPath = join(BHAGWAT_TMP_DIR, `${tmpId}_concat.txt`);
  const audioPath = join(BHAGWAT_TMP_DIR, `${tmpId}_audio`);
  const imgDir = join(BHAGWAT_TMP_DIR, `${tmpId}_imgs`);
  const outputPath = join(BHAGWAT_RENDERED_DIR, `${jobId}.mp4`);

  mkdirSync(imgDir, { recursive: true });

  try {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

    // ── 1. Download audio ─────────────────────────────────────────────────────
    emit("progress", { percent: 3, message: "Downloading audio from YouTube…" });
    await runYtDlp(["-f", "bestaudio", "--no-playlist", "--no-warnings", "-o", `${audioPath}.%(ext)s`, url]);

    const audioFiles = readdirSync(BHAGWAT_TMP_DIR).filter(f => f.startsWith(basename(audioPath)));
    const audioFile = audioFiles.length > 0 ? join(BHAGWAT_TMP_DIR, audioFiles[0]) : null;
    if (!audioFile || !existsSync(audioFile)) throw new Error("Failed to download audio from YouTube");

    // ── 2. Generate images for all segments ───────────────────────────────────
    emit("progress", { percent: 8, message: `Generating ${timeline.length} scene images with Gemini…` });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

    const imagePaths = await generateAllSegmentImages(
      genAI,
      timeline,
      imgDir,
      (done, total, desc) => {
        const pct = 8 + Math.round((done / total) * 52); // 8% → 60%
        emit("progress", { percent: pct, message: `Generating image ${done}/${total}: "${desc.slice(0, 50)}"…` });
      }
    );

    const totalGenerated = imagePaths.flat().filter(p => p && existsSync(p)).length;
    if (totalGenerated === 0) throw new Error("Image generation failed — no images were created");

    emit("progress", { percent: 62, message: `${totalGenerated} images generated. Building video sequence…` });

    // ── 3. Build ffmpeg concat list ───────────────────────────────────────────
    const concatLines: string[] = [];
    const usedIndexPerSeg = new Array(timeline.length).fill(0);

    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      const segDur = seg.endSec - seg.startSec;
      if (segDur <= 0) continue;
      const pool = imagePaths[i].filter(p => p && existsSync(p));
      if (pool.length === 0) continue;

      let elapsed = 0;
      while (elapsed < segDur - 0.1) {
        const dur = Math.min(seg.imageChangeEvery, segDur - elapsed);
        const imgPath = pool[usedIndexPerSeg[i] % pool.length].replace(/'/g, "'\\''");
        concatLines.push(`file '${imgPath}'`);
        concatLines.push(`duration ${dur.toFixed(3)}`);
        usedIndexPerSeg[i]++;
        elapsed += dur;
      }
    }

    if (concatLines.length === 0) throw new Error("Could not build image sequence from generated images");

    // FFmpeg concat quirk: last file must repeat without duration
    const lastFile = [...concatLines].reverse().find(l => l.startsWith("file"));
    if (lastFile) concatLines.push(lastFile);
    writeFileSync(concatPath, concatLines.join("\n"));

    emit("progress", { percent: 65, message: "Rendering video with FFmpeg…" });

    // ── 4. FFmpeg render ──────────────────────────────────────────────────────
    const totalDuration = timeline.reduce((s, seg) => s + (seg.endSec - seg.startSec), 0);
    job.filename = `bhagwat_${tmpId.slice(0, 6)}.mp4`;

    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-f", "concat", "-safe", "0", "-i", concatPath,
        "-i", audioFile,
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-y", outputPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        const match = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g);
        if (match) {
          const last = match[match.length - 1];
          const [, h, m, s] = last.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/)!;
          const cur = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
          const pct = totalDuration > 0 ? Math.min(98, 65 + Math.round((cur / totalDuration) * 33)) : 80;
          emit("progress", { percent: pct, message: `Rendering… ${formatTime(cur)} / ${formatTime(totalDuration)}` });
        }
      });
      ff.on("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-400)}`)));
    });

    // ── 5. Cleanup ────────────────────────────────────────────────────────────
    try { unlinkSync(concatPath); } catch {}
    try { unlinkSync(audioFile); } catch {}
    try {
      for (const f of readdirSync(imgDir)) try { unlinkSync(join(imgDir, f)); } catch {}
      rmdirSync(imgDir);
    } catch {}

    emit("progress", { percent: 100, message: "Video ready for download!" });
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
